# Tag 记忆检索全链路（综合验证版）

> **日期**：2026-08-12
> **方法**：五份文档深读（MEMORY_SYSTEM / RUST_VECTOR_ENGINE / TagMemo_Wave_Algorithm_Deep_Dive / TAGMEMO_TUNING_GUIDE / RIVERMEMO_TOPOLOGY_V3）＋ 源码逐行交叉验证（RAGDiaryPlugin / KnowledgeBaseManager / TagMemoEngine / RiverMemoEngine / ingestionPipeline / searchService / schemaManager / dailynote）
> **立场**：**文档是规格，源码是现状**。凡文档与代码冲突处，以源码为准并在此标注。
>
> 关联记忆：`tagmemo-production-is-rust`、`daily-note-write-legacy-dead-path`、`vector-index-persistence-config-gated`、`docs-generation-gap`、`gated-placeholder-threshold-uses-bare-name-vector`、`rerank-plus-modifier-is-inert-here`、`meta-thinking-recall-is-plain-knn`、`tag-curve-is-ordered`

---

## 0. 文档版图：两个时代的重叠

| 文档 | 性质判定 |
|---|---|
| `TagMemo_Wave_Algorithm_Deep_Dive.md`（2026-07-15） | **算法语义的权威文档、执行位置的过时文档**。11 环节公式与默认值是 Rust 移植的规格，可引用；但「由 JS 执行」的表述已退役（rust-memo-runtime 下 JS 抛 `TAGMEMO_JS_GRAPH_RUNTIME_RETIRED`）。全文无 Ω/RiverMemo/V10 字样 |
| `MEMORY_SYSTEM.md` + `RUST_VECTOR_ENGINE.md` | **已退役的 JS V3.7 架构**：chokidar 唯一写入入口、JS TagMemo 四阶段、.usearch 默认持久化——三者均与实况相反。RUST 版停滞 2026-02-13 |
| `RIVERMEMO_TOPOLOGY_V3.md` | **与当前代码吻合度最高**：Ω 公式、κEdge=0.5/κRatio=0.3/ε=0.02、0.12/0.45 分档逐项一致。全文无「测地线」字样 |
| `TAGMEMO_TUNING_GUIDE.md` | 76 行参数表，可引用；无完整公式链（公式链在代码） |

**一句话**：写入实况是「AI 工具调用 → Rust 管线」，文档写的是「chokidar → JS 浪潮」——前者是现状，后者是规格。

---

## 1. Tag 的一生（写入侧）

```
日记文件（Content 尾行 Tag:...）
  → _extractTags：只收文档尾部连续元数据区的 Tag 行（正文中的 Tag: 被忽略）
      黑名单 / 日期剔除 / 长度上限（中文>20、非中文>40）/ 每文件 ≤50 个截断
  → 分隔符 [,，、;|｜] 拆分 → Set 去重 → tag 向量单独批量 embedding（与 chunk 分开）
  → SQLite 事务：tags(name UNIQUE, vector BLOB) + file_tags(file_id, tag_id, position)
      ↑ position = 书写顺序 —— Tag 链是有序曲线（[[tag-curve-is-ordered]] 的源码基础）
  → tagIndex（全局 tag 索引，USearch HNSW）增量 add（Duplicate 冲突先 remove 再 add）
  → 共现矩阵：file_tags 自连接 COUNT 按 tag 对分组 → tag_pair_similarity + 状态表（负缓存）
  → 图构建（WaveDoc §5，公式链见 §3.1）
```

### 1.1 幂等与容错（ingestionPipeline.js _flushBatch）

- **两级快路径**：① mtime+size 未变且 `_hasCompleteStoredVectorsForFile` 通过 → 连文件都不读（:146）；② md5 checksum 未变且向量齐全 → 只 `UPDATE files SET mtime,size`，不重新 embedding（:164-167）
- **BUSY/损坏保留队列**：忙锁属数据库级瞬态失败，抛给批次边界统一保留，**不消耗 fileRetryCount**（:176-181 注释为证）；损坏时停文件 watcher 防重试风暴、清 pendingFiles、等待人工重启重建
- **读取窗口不稳定防线**：读文件窗口内被改动 → 本次不入库不失败（:148-160）
- **索引持久化是配置门控**：`shouldPersist = persistDefault || persistFolders.has(name) || name.endsWith('簇')`（indexRepository.js:28-35）。live 配置无 PERSIST_* 键 → 磁盘只有「簇」日记本 + 全局 tag 索引**每次启动从 SQLite 全量重建**（KBM:284-313）
- 向量维度 `VECTORDB_DIMENSION=3072`；embedding 模型 max token 默认 8000，分块 0.85 / 重叠 0.10（TextChunker.js:7-9）
- 嵌入批大小：EmbeddingUtils 默认 32，生产 `EMBEDDING_MAX_BATCH_ITEMS=100`（config.env）→ 实测每批 100 条（T1 实测确认）

---

## 2. 检索侧全链路（站 0 → 站 12）

### 站 0 · 触发：占位符四态 + 修饰符 + 动态 k

| 语法 | 行为 |
|---|---|
| `{{X日记本}}` | 无条件全文直取（DirectDiaryTextProcessor）；纯 `{{}}` 消息走零向量化快速路径 |
| `[[X日记本]]` | 无门控 K-NN 片段检索（_processRAGPlaceholder） |
| `<<X日记本>>` | 单阈值门控，过阈后**复用 `{{}}` 全文管线** |
| `《《X日记本》》` | 双阈值门控，过阈进 RAG 片段检索 |

门控语义（已实测）：相似度比的是 **`max(cos(query, embedding(日记本名)), cos(query, enhancedVector))`**——裸名字符串 embedding；本机无 `rag_tags.json` → enhanced 恒 0；阈值 0.6 对 4~7 字短串几乎不可达 → `《《》》` 在本部署等于默认关闭。要稳定召回用 `[[ ]]`。

**动态 k**（RAGDiaryPlugin.js:822-875）：
```
k_base 按长度档 3/4/6；L=logicDepth、R=resonance（EPA 供数）、S=语义宽度
kAdjustment = round(L·3 + log1p(R)·2)
finalK = max(3, min(10, k_base + kAdjustment))     // 下限 3、上限 10
新对话补偿 ×1.2（assistant<2 时）
```

**修饰符**（`日记本`三字后的第二捕获组，`::` 前缀、`/` 分隔参数、数值后缀）：

| 修饰符 | 语义 | 实测备注 |
|---|---|---|
| `::Time` | 时间表达式解析 + 双路召回 `kTime=k·timeRatio`（默认 0.2 → 80/20） | ✅ |
| `::TimeDecay30/0.5/box` | 半衰期（默认 30 天）`0.5^(diffDays/halfLife)` + minScore 0.5 + 白名单标签豁免 + time 源豁免 | ✅ |
| `::Group` | SemanticGroupManager 语义簇扩展查询向量 | ✅ |
| `::TagMemo+` | 测地线重排（geodesicRerank）；**与 ::RiverMemo 互斥，RiverMemo 在场时完全失效** | ✅ |
| `::Rerank+0.7` | 外部 Reranker；RRF 实现存在（`α/(60+rank₁)+(1−α)/(60+rank₂)`，RRF_K=60）但**本机无 Rerank* 配置 → JIT 短路，不可达** | 空转 |
| `::BM25/::BM25+` | 稀疏关键词混合，`hybrid = BM25·w + vector·(1−w)`（默认 0.6/0.4） | ✅ |
| `::Truncate` | **无 0.25 默认值**；按候选分数过滤（`score ≥ threshold`），非按长度砍注入 | 纠正 |
| `::AIMemo:预设名` | 冒号后是**预设名**（MoreAIMemoPresets/*.json）非压缩比；需 `[[AIMemo=True]]` 许可 | 纠正 |
| 裸 `:1.5` | k 倍率（聚合层乘一次） | ✅ |

### 站 1 · 感应：EPA + 残差金字塔（tag 被「感知」）

```
EPA 投影：p_k = ⟨v,u_k⟩² / Σ_j⟨v,u_j⟩²
         H = −Σ p_k·log₂ p_k
         logicDepth = 1 − H/log₂K
共振：C_ij = √(E_i·E_j)，阈值 0.15，balance = min/max
残差金字塔：Modified Gram-Schmidt 逐层分解（mag>1e-6 入基），
           残差能量 < 原始 10% 截断
           coverage = E_proj/E_orig
           tagMemoActivation = coverage × coherence × (1 − noiseSignal)
           noiseSignal = (1−coherence)(1−patternStrength)
```
EPA 基底由 Rust density-residual-sampling 训练（K-Means Forgy 收敛 1e-4 / Weighted SVD / Power Iteration）。判定结果**不直接决定输出**，只调节 TagMemo 激活强度与核心标签权重。

### 站 2 · 扩张：Core / Ghost 补全

- **Core Tag**：字符串形式未被向量感应命中时从 SQLite 补全；只作最终融合锚点，**不再作为扩大拓扑传播的隐式种子**
- **Ghost Tag**：调用方提供、未入库但有向量的临时概念，负 ID，只参与本轮融合，不写持久图

### 站 3 · 动态增益（代码公式 + 文档范围值）

```
activationMultiplier = 0.5 + tagMemoActivation·1.5                ∈ [0.5, 1.5]
dynamicBoostFactor   = logicDepth·(1+resonanceBoost)/(1+entropyPenalty·0.5) · activationMultiplier
effectiveTagBoost    = baseTagBoost · clamp(dynamicBoostFactor, [0.3, 2.0])
β = sigmoid(L·log(2+R) − S·noise_penalty)          // 映射 tagWeightRange=[0.05,0.45]
coreBoost：dynamicCoreBoostFactor ∈ [1.20, 1.40] × (0.95 + 个体相关度×0.1)
双重门控：adjustedWeight = contribution × layerDecay(0.7^level) × langPenalty × coreBoost
```

### 站 4 · 引力融合（tag 重塑查询向量）

```
c = Σ wᵢ·vᵢ（标签上下文加权平均）→ 单位化
q' = (1−α)·q + α·c          α = min(1, effectiveTagBoost)，夹逼 [0,1] 防反向外推
q' 再单位化进 Vexus
```
**关键**：tag 不直接改 chunk 排序，而是重塑查询向量、间接影响检索。

### 站 5 · 召回：Vexus KNN

USearch 2.8 HNSW：L2sq / F32 / M=16 / expansion_add=128 / expansion_search=64 / 自动扩容 1.5× / 默认容量 50k。多日记本（联合索引）：**只跑一次增强，所有物理索引共用同一增强向量**，合并候选后统一重排 + 全局 Top-K（每物理索引仍有候选配额 perIndexK）。
同书挤占（N6 实测，12 跨书采样查询）：top-8 **无查询书占满**（最高 5/8=VCP开发），但**大书反挤占**——纸子的知识（133 文件，库的 2/3）在 Metis/Ryan 查询里占 7/8（S1=0.875），小书查询结果里大书反客为主；RiverMemo rerank 前后 S1 逐查询不变（不缓解）。候选池层面每索引有 perIndexK=8 配额，挤占发生在最终 top-8 选择。S1 兄弟探针指标改准：不测「查询书占满」（不存在），改测「top-k 同书席位数是否挤掉跨书连接」（即门①无孤岛想保的东西）；跨书多样性约束若做，落点在 rerank 之后的候选选择阶段（引擎 RFC，不进 tag 写入判据）。

### 站 6 · 场局部连续化（tag 向量成为势能场）

```
查询场 F_q = {(z_j, E_j) | E_j > 0}，按本轮最大值归一化（不跨库重标定）
来源 source(z_j) ∈ {core, seed, emergent(hop)}——不改势能、只影响证据分级
局部核：k(x_i,z_j) = [(cos(x_i,z_j) − τ_s)/(1 − τ_s)]₊^p      τ_s=0.50, p=2.0
u_ij = Ê_j · k(x_i,z_j) · specificity(j)
U(x_i) = clip₍₀,₁₎( max(U_exact, Σ_{j∈TopM(i)} u_ij / √|TopM(i)|) )   TopM=4
```

### 站 7 · Tag 有序曲线评估（tag 链成为「路径」）

```
曲线 Γ_c = (t₁,…,tₙ) 取自 file_tags.position，闭合为 q→t₁→…→tₙ→c
Tag 质量  M_i = closure(t_i,c) · residual(t_i) · position(t_i) · specificity(t_i)
Coverage(c) = Σ Mᵢ·1[U(tᵢ)≥τ_w] / Σ Mᵢ                    τ_w：强 0.16 / 弱 0.06
弧长      L(Γ_c) = Σ arccos(cos(tᵢ,tᵢ₊₁)) / π
作用量    A(Γ_c) = Σ d_∠(tᵢ,tᵢ₊₁)·√(MᵢMᵢ₊₁) / (ε + √(U(tᵢ)U(tᵢ₊₁)) + λP_{i,i+1})
                   （作用量质量指数衰减映射；孤峰受罚、低谷有限通过）
Target(c) = max(1, min(minGeoSamples, ⌈√|Tags(c)|⌉))       // 证据饱和目标
Confidence(c) = Coverage·(0.55 + 0.45·EvidenceConf)·(1 − 0.65·IsolatedRatio)
Geo(c) = Confidence·(0.30Ū + 0.20U_max + 0.20Continuity + 0.15Action + 0.15Closure)
```

### 站 8 · 证据分级与绝对标度奖励

```
G(c) = clip₍₀,₁₎((Geo(c) − g₀)/(g₁ − g₀))      // g₀/g₁ 绝对奖励起点/饱和点，跨批次同义
三档：direct > structural > thematic
  direct：精确接触 core/seed，或多高势能 Tag 直接语义接触 core/seed
  structural：精确接触传播节点 / 多点非孤立连续走廊
  thematic：仅局部核插值共振
Bonus(c) = min(B_class(c), α·Confidence(c)·G(c))
score(c) = score_v9(c) + Bonus(c)               // 只正向，无证据候选保持原分
语义直锚升级：来源必须 core/seed（非远端传播节点）+ 单点势能 ≥ directSemanticMinPotential
             + 独立接触数 ≥ directSemanticMinContacts；可设 directConfidenceFloor
```

### 站 9 · 几何影子与受限辅助奖励

```
F(c) = clip₍₀,₁₎([1 − (1−w_D·D)(1−w_S·S)(1−w_T·T)] · C₄)
Dir(c) = Σ_e ω_e·[P_e^→/(P_e^→ + P_e^←)] / Σ_e ω_e
R_geo = ∛(R_F · R_class · R_C₄)
L_geo = C_class(c) · R_geo^γ
严格身份锚地板 L_id：高势能 + 非公共枢纽 + 与 chunk 闭合良好的 core/seed 精确接触
Bonus_aux = min(B_aux^max, [min(B_class, max(L_geo, L_id)) − Bonus_base]₊)
Bonus_final = min(B_class, Bonus_base + Bonus_aux)
当前硬上限：辅助补差 0.018 / 结构地板 0.012 / 主题地板 0.006
```

### 站 10 · RiverMemo 拓扑 V3（`::RiverMemo` 时；与 TagMemo+/测地线路二选一）

```
图 G=(V,E,P)：V=Tag 节点、E=有向关系边、P_ij=传输率（Σ_jP_ij < 1 严格次随机）
查询河网 R_q：本次查询实际走过的子图（节点存能量/来源角色/最短跳数，边存实际流量）
双场（resolvent）：u_α = (1−α)(I−αT)⁻¹S
    局部场 α_L=0.15（源附近稳定解释）、迁移场 α_T=0.55（沿可靠关系传远）
    有效支持域 η_L=0.8 / η_T=0.9（主质量只能来自支持域内接触）
传播：f_ij^(h) = e_i^(h)·P_ij·d_ij·ρ_ij       ρ_return=0.15 软非回溯
有限时域：w_t = γ^t / Σ_{r=0..T} γ^r，γ=0.60；E = Σ w_t·h^(t)
路径几何：段势 U^(i) = √(u(tᵢ)·u(tᵢ₊₁))
         方向 D_i = P_{i,i+1}/(P_{i,i+1}+P_{i+1,i})
         连续性 C_i = ½Cᵢ^semantic + ½Cᵢ^field
         段质量 Q_i = U_i·√(max(D_min,D_i))·√C_i（未进支持域则 Q_i=0）
相对拓扑：A(r,t) = √(Semantic(r,t)·Closure(t,c))
         G_e = A_e·D_e^relative·D_e^direction·I_e     （I_e 降候选文件自循环自证；
                                                         N8 实测：I_e/closure 不进 S₀，只在 B_G 侧参与 G_e）
         T(c) = w_N·N_c + w_R·D_c + w_→·Dir_c + w_E·E_c + w_M·M_c
直接锚（hop-0 事实通道，与河网密度正交）：
         a_sc = m_s·Spec(t)·Closure(t,c)·Rarity(s)·Match(s,t)
         A(c) = 1 − ∏_s(1 − a_sc)                    // noisy-OR 聚合
         R_A(c) = √(Closurē·min(1, N_contact/N_sat))   // N_sat = reliability_seed_saturation = 2.0
         H(c) = A(c)·R_A(c)
   N9 实测（2026-08-12，3 裸名查询×16 结果=48 行 trace）：接触数多数 1、少数 2（现存日记在
   悬崖左侧）；R_A 半衰真实（1 接触 0.53 vs 2 接触 0.79），但 B_H 实际支付由 A×动态阈值
   θ_H=max(0.05, μ+2σ) 决定——48 行仅 2 行 >0（0.0525/0.0356），典型 1 接触 A 只有 0.004-0.03
   被 0.05 地板压死，2 接触也不保证过线。「≥2 接触」是必要非充分；锚通道实质是 batch 内
   top-1 晋升（promote+contrast），非渐进付款通道
```

### 站 11 · Ω 门控与总评分（V3 精髓：候选证据服从查询可观测性）

```
Ω_E = clip₍₀,₁₎(M / (κ_E·max(1,N_s)))        // 实际激活边数/边尺度×种子数，κEdge=0.5
Ω_N = clip₍₀,₁₎(N_e / (κ_N·max(1,N_s)))      // 涌现节点/尺度×种子数，κRatio=0.3
      N_s = seedNodes，由 Rust 侧 source observation（查询向量→tag KNN 命中）决定，
      与占位符/coreTags 数量无关（T9 实测：1 seed vs 3 seed 的 Ω 逐位相同 0.776854525128601）
Ω_F = (−Σ p_k·log p_k)/log|E⁺|               // 流熵；单条正流边 0.5、无正流 0
Ω   = clip₍₀,₁₎( ∛(max(Ω_E,ε)·max(Ω_N,ε)·max(Ω_F,ε)) · χ_obs )   ε=0.02
      χ_obs = 1（完整观测）/ 0.5（不完整）——几何平均：单维退化即压整体
regime：Ω < 0.12 collapsed / < 0.45 sparse / ≥ 0.45 dense（同一泛函的区间标签）
   Ω 改述（陆轮实测）：Ω 高不表示健康——583 tags·64590 pairs 平均度 221.6、图密度 38%，
   稠密图天然容易涌现（实测 dense 档 Ω=0.777、Ω_N=0.889 近饱和）。Ω 是「可观测性」读数
   不是「通道通畅度」；「提升 Ω」无旋钮（T9 已证 coreTags/占位符不是种子，查询侧不可控）。
   稠密图里边权是「份额」不是「量」，能否被探索是「排名」（Σ_jP_ij ≤ 0.95 摊给 ~221 邻居，
   每条平均 0.004；30 种子只点亮 8-10 条边的直接原因）。
S_V3(c) = clip₍₀,₁₎[ S₀(c) + Ω^γ·B_G(c) + B_H(c) ]
      S₀ = 基础场分（原查询+降噪+局部场+迁移场+路径质量+正文闭合）
      B_G ≥ 0 非负结构增量（相对拓扑 T(c) 作结构证据）
      B_H = C_H·smoothstep((H(c) − θ_H)/(H_sat − θ_H))，θ_H = μ_H + z·σ_H
```

**三通道分工不变量**（陆轮实测定案，2026-08-12）：

| 通道 | 上限 | 性质 | 喂它的东西 |
|---|---|---|---|
| S₀ 场分基底 | 永久（绝对） | 三场分 + topology_bonus（路径质量 0.625、覆盖/势能 0.375，topology_bonus_cap 0.08×reliability） | P_ij 经 hub 校正、e_ij、方向、连续性 |
| Ω^γ·B_G | 0.777×0.08≈0.062 | **差分 · 会蒸发** | I_e、tag_closure、相对拓扑；E(G\|Z) 是查询时 peer 高斯核（同角色 1.0/其他 0.35），z=1；cap 0.08 按角色；书内查询 E(G\|Z) 自我抵消 → 脊柱在 B_G 上收益≈0 |
| B_H 锚 | 0.100 | 半相对（弱批时地板 0.05 绑定 → 事实上绝对） | Spec、Closure、Rarity、Match、N_contact |

**锚通道（0.100）是主付款通道，拓扑（0.062）是副的**；拓扑侧且会蒸发、peer 依赖。

总方程（文档 18-51 行）完整形态：

```
S_i = Π₍₀,₁₎[ S_i^field + Ω_Q^γ·Π₍₀,C_ri₎( λ_ri·C_i·[G_i − E(G|Z_i) − z·σ(G|Z_i)]₊ )
              + C_A·SmoothStep((A_i·R_i^A − τ_A)/(s_A − τ_A)) ]
```
关系拓扑通道**只奖励超出「同条件期望 + 不确定性上界」的正创新**；锚通道独立上限 C_A。
两个 z 不是同一个（N5/N7 实测）：总方程拓扑侧 z=1（`topologyV2InnovationConfidenceZ`，TagMemoV10Engine.js:373，文档旧值 2.0 过时）；锚通道 θ_H 侧 z=2（`anchorActivationZ`，生产默认）。

### 站 12 · 后处理与注入

```
Time → TimeDecay → Group → BM25 → Rerank(RRF) → Truncate → AIMemo → 语义去重(0.92/0.97)
→ RAGResultFormatter: <!-- VCP_RAG_BLOCK_START {meta} --> + 内容 <!-- VCP_RAG_BLOCK_END -->
  meta：dbName / diaryNames / virtualIndex / modifiers / k / engine(RiverMemo|TagMemo|KNN)
        / bm25 / bm25Weight / timeRatio（V4.0 起无 originalQuery）
→ 下一轮 _refreshRagBlocksIfNeeded（chatCompletionHandler.js:531-625，每轮对话调用）：
  解析旧块 → 倒查最后真实 user 消息 → refreshRagBlock：净化三内容 → 并行 embedding
  → refreshWeights [0.5, 0.35, 0.15] 加权 → 复用 _processRAGPlaceholder 完整重跑
  缓存键含 userContent → 必不命中旧缓存 → 真重算
```
注：`VCP_RAG_BLOCK` 块格式是被多方依赖的协议（ContextFoldingV2/CapturePreprocessor/OpenHerPersona/OneRing 共享；TDBPlaceholderProcessor 特意不用以避免被刷新劫持）。
注（T8 实测）：去重并非全链路生效——0.92 出自 ResultDeduplicator.js:19，只在日记本 RAG 路径**显式调用**（RAGDiaryPlugin.js:2882-2891/2936-2945/3078-3084）；元思考路径不去重（MetaThinkingManager 全文不调 deduplicateResults，searchService.js:356/:587 直接返回）；0.97 是最终池 fallback 阈值。候选池按日记分池（perIndexK 配额，见站 5）。

### 守卫回退三层（V9.2）

查询场级（最小正能量 Tag 数 / 最小场熵 / 场 Tag 向量可用）→ 候选级（缺 chunk 向量 / 缺有序 Tag 链 / 无场接触 / 质量无法构造）→ 批次级（无贡献候选 / 覆盖+曲线分+强证据联合不足 / 区分度联合不足）。**覆盖率低不再单独触发整批回退**。

---

## 3. 关键算法细节补充

### 3.1 图构建公式链（WaveDoc §5）

```
有序双向事实矩阵：同文件标签对按 position 构造顺/逆流边
  序位势能 Φ ∈ [0.5, 0.9] × 位置距离衰减 × 顺逆流阻尼 × pairwise 钟形余弦增益 × 概念锚
  位置距离衰减 distanceDecay=0.08（生产默认，memo_artifact_builder.rs:450，w=exp(−0.08·Δpos)）
  顺逆流双侧：正向边与逆向边分别处理（dynamic_reverse），逆流 ≤ 顺流 × reverseInversionGuard（0.95，生产无覆盖）
→ 只算实际共现 pair（免 N²）；正值写 tag_pair_similarity，状态写 tag_pair_similarity_status
  （computed/below_threshold/missing_vector，负缓存防重复计算）
→ e_ij = log(1 + λ·W_ij)              // 对数证据压缩
→ T_ij = e_ij · r_j                    // 残差张力（r_j = Intrinsic Residual）
→ 虫洞增益 g_ij = e_ij·G_wormhole（归一化前施加：只争预算、不增总出流）
→ 入流枢纽校正 → 出流预算 m_out（Σ_jP_ij ≤ m_out ≤ 1）→ 传播核 P_ij
  hub 校正（N3 实测解构）：relative = target_inflow/(median+smoothing)，median=0.593、
  smoothing=median×0.1；penalty = relative^(−0.3) clamp [0.55, 1.8]（3.27× 杠杆=两端比值）。
  hub 按入流判非频率：79 枚 tag relative>2；「解构中」是超级枢纽（45.9×）。自限机制：
  脊柱越成功 → 成员入流越高 → 惩罚越重（1.8→0.55），引擎主动抵抗全库枢纽 → 全库脊柱逆着引擎走。
```

### 3.2 Intrinsic Residual（节点级，区别于查询级残差金字塔）

`r_i = ‖(I − U_iU_iᵀ)v_i‖₂`（单位化下 0≤r_i≤1）。生产默认 `anchored_gs`（迭代选最能解释残差的邻居方向，最多 maxBasis 次，评分 explainGain×topology×semantic；备选 centroid/svd）。固定锚增益 `a(r) = clip(a₀ + kr^γ, a_min, a_max)`——数据库无关的固定单调映射，**明确不用 Min-Max/median/MAD 重标定**。

### 3.3 脉冲传播约束集（V9.1 有界传播）

状态四元组 `(prev, node, energy, momentum)`（同节点不同前驱保留不同状态，识别立即回流）；约束：最大安全跳数 / firing threshold / 普通边与虫洞边衰减 / 普通边动量消耗 / 每节点最大邻居数 / 最大传播状态数 / 涌现节点上限（超限只留能量最高者）。

### 3.4 版本史（WaveDoc:1443-1546）

```
V4   多点召回（Semantic Segmentation、Shotgun Query、SVD/Residual 去重）；PSR 已删，对冲目标迁到动态提示词
V6   无向脉冲扩散（EPA 动态激活、Residual Pyramid、LIF 传播、Core Boost、语言门控）→ V9.1 感应底座
V7   有向序位与虫洞（Tag 顺序、Intrinsic Residual、动量、残差张力虫洞）；单向硬切改双向阻尼
V8/V8.2  势能场重排 + 有序双向图（三轴解耦、Pairwise 持久化、顺逆流阻尼与反转守卫）
V8.3 Rust 工程化（EPA 密度残差采样、Anchored-GS IR、写租约、派生任务队列）→ 并入 V9.1 底座
V9/V9.1  有界局部选择 + 查询诱导式曲线测地线（当前底座，单轨生产）
V9.2  曲线读出校准（发现关联 vs 授予排序权分离）
文档当前标识：传播底座 V9.1 / 曲线读出 V9.2 / 对外版本 v9
⚠️ 文档全文无 V10；代码已有 modules/tagmemoV10/riverObservability.js（Ω 即 V10 模块）
```

### 3.5 两条排序路径对照

| | 测地线路（::TagMemo+ / 默认 KNN） | 河道路（::RiverMemo） |
|---|---|---|
| 排序依据 | 曲线几何：Geo(c) = Confidence·(覆盖/势能/连续/作用量/闭合) | 相对拓扑：T(c) 五项 + 直接锚 H(c) |
| 门控 | 证据分级 G + Bonus（只正向） | **Ω^γ 全局门控**（候选证据服从查询可观测性） |
| 关键参数 | α_L/α_T 场、τ_s/p/TopM、τ_w、g₀/g₁、分级上限 | κEdge/κRatio/ε、χ_obs、γ、θ_H |
| 互斥 | ::RiverMemo 在场时 TagMemo/TagMemo+ 完全失效（tagWeight=null） | — |
| 执行 | Rust memo_pipeline.rs（JS 已退役） | Rust rerankRivermemoTopologyV3 / memo_dtsc.rs |

---

## 4. Tag 的完整旅程（一图流）

```
写入: 尾部 Tag 行 → 向量化 → tags 表 + position 序 → 全局 tag 索引 → 共现矩阵 → P_ij 图
检索: 感应(EPA+残差金字塔) → 补全(Core/Ghost) → 增益(dynamicBoost) → 融合(α) → KNN
      → 场连续化(U 势能) → 曲线评估(Geo) → 证据分级(Bonus)
      → [::RiverMemo] 相对拓扑(T) → Ω 门控 → S_V3 = S₀ + Ω^γ·B_G + B_H
      → 注入 VCP_RAG_BLOCK → 下一轮 refreshWeights [0.5,0.35,0.15] 重算刷新

tag 每站角色：感应(基底) · 扩张(补全源) · 增益(α 调解) · 融合(重塑查询向量)
              · 召回(tag 索引) · 场(势能节点) · 曲线(路径点) · 图(河网实体)
              · 门控(seed 数进 Ω 分母)
```

---

## 5. 调参速查表

| 参数 | 默认 | 作用 |
|---|---|---|
| `noise_penalty` | 0.05 | 抵消语义宽度噪音；调高更挑剔、只强聚焦触发增强 |
| `tagWeightRange` | [0.05, 0.45] | β 映射范围 = 标签能量占比上限 |
| `tagTruncationBase` | 0.6 | 感应阶段保留前多少比例标签 |
| `activationMultiplier` | 0.5 + act·1.5 | 金字塔新颖特征贡献度 |
| `dynamicBoostRange` | [0.3, 2.0] | EPA 对权重的二次修正夹逼 |
| `coreBoostRange` | [1.20, 1.40] | coreTags 额外加权 |
| `deduplicationThreshold` | 0.88 | 标签级去重余弦阈值 |
| `techTagThreshold` | 0.08 | 英文/技术词汇生存门槛 |
| `fieldSimilarityThreshold` τ_s | 0.50 | 场局部核起点 |
| `fieldKernelExponent` p | 2.0 | 场核指数 |
| `maxFieldNeighbors` TopM | 4 | 每 Tag 最多场邻居数 |
| `strongContact/weakContact` τ_w | 0.16 / 0.06 | 曲线强/弱接触 |
| `κEdge / κRatio / ε` | 0.5 / 0.3 / 0.02 | Ω 尺度（**文档未写，代码有**） |
| `χ_obs` | 1 / 0.5 | 观测完整度 |
| regime 分档 | 0.12 / 0.45 | collapsed / sparse / dense |
| 辅助地板硬上限 | 0.018/0.012/0.006 | direct/structural/thematic |
| `minGeoSamples` | 4 | 证据饱和尺度 |

---

## 6. 文档-代码代差清单（引用文档前必看）

1. **WaveDoc 的「由 JS 执行」已退役**——生产是 Rust `memo_pipeline.rs` + `memo_dtsc.rs`；JS `applyTagBoost`/`geodesicRerank` 在 rust-memo-runtime 下抛 `TAGMEMO_JS_GRAPH_RUNTIME_RETIRED`。公式照用，执行者别信
2. **MEMORY_SYSTEM.md 整章过时**——chokidar 唯一写入入口、JS 四阶段、.usearch 默认持久化，均与实况相反；`KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY` 是死配置；`_cleanupGhostIndexes` 是死代码（无调用点）
3. **写入源头**：`executePlugin("DailyNoteWrite")` 是死路径必抛错；真实写入是 AI 工具调用 `DailyNote create/update`（direct 常驻）→ dailynote.js；旧知识文档「AI 输出 <<<DailyNoteStart>>> 提交日记」过时
4. **V3 无「测地线」**——geodesic 是 V8 词汇；V3 用相对拓扑 + Ω 门控；`::TagMemo+`（测地线路）与 `::RiverMemo`（拓扑路）**互斥**（RAGDiaryPlugin.js:2689-2696），V8 文档「TagMemo+ 是超集」已废止
5. **Ω 三参数 κ/ε 文档未给值**（代码 riverObservability.js:45-50）；日志形态文档（native* 字段）与实际（`🌊 RiverMemo: offered=…, ranked=…, returned=…, Ω=…, regime=…`）不符
6. **allowedFileIds 权限域、riverOfferK（maxUnionCandidates=300）文档完全没写**，代码有
7. **::Truncate 无 0.25 默认、::AIMemo 数字是预设名**——文档均未记载（代码为据）
8. **元思考路径是纯 KNN**——`MetaThinkingManager.js:232` 三参 search → tagBoost=0 → 无拓扑无重排；THEORY §5「召回机制与日记完全相同」对元思考路径为假

---

## 7. 关键源码锚点索引

| 环节 | 位置 |
|---|---|
| 占位符四态解析 | RAGDiaryPlugin.js:1543-1547 |
| 动态 k 公式 | RAGDiaryPlugin.js:822-875 |
| 聚合检索（虚拟索引） | RAGDiaryPlugin.js:2418-2487；searchService.js:368-471 |
| 门控相似度（裸名向量） | RAGDiaryPlugin.js:3824-3852 |
| Rerank JIT 短路 | RAGDiaryPlugin.js:4100-4105；RRF :4288-4318 |
| ::RiverMemo 接线与互斥 | RAGDiaryPlugin.js:2665、2689-2696、3232-3368 |
| 注入块格式 | RAGResultFormatter.js:20-23 |
| 块刷新 | chatCompletionHandler.js:531-625；RAGDiaryPlugin.js:2513-2592 |
| 浪潮生产链（Rust） | KnowledgeBaseManager.js:974→1307；rust-vexus-lite/src/memo_pipeline.rs、memo_dtsc.rs |
| Ω 公式 | modules/tagmemoV10/riverObservability.js:44-131 |
| 测地线实现（JS，参考） | TagMemoEngine.js:1653-2893 |
| 幂等快路径 | ingestionPipeline.js:146、164-167 |
| BUSY 保留队列 | ingestionPipeline.js:176-181、488-498 |
| 持久化门控 | indexRepository.js:28-35 |
| 表结构 | modules/knowledgeBase/schemaManager.js:3-264 |
| 写入（工具调用） | Plugin.js:613-615、899；dailynote.js processToolCall |
| 元思考纯 KNN | MetaThinkingManager.js:232、277-284；searchService.js:131/161/187 |

---

## 8. 已知缺口与悬案

1. `allowedFileIds` 权限域圈定机制无文档
2. `riverOfferK`/`maxUnionCandidates=300` 无文档
3. 文档日志字段（native*）与实际日志（offered/ranked/returned/Ω/regime）不区分诊断级与运行级
4. 文档无 V10（代码已有 tagmemoV10 模块）；`memo_pipeline.rs` 无对应深潜文档
5. Ω 的 κ/ε 默认值只存在于代码
6. `reset_vectordb.js` 已过时（针对旧格式 vectordb.sqlite + .bin），运行它重置不到任何现行索引
7. 跨书多样性约束是引擎 RFC（N6 实测大书挤占 7/8，rerank 不缓解）：落点在 rerank 后的候选选择阶段；不进 tag 写入判据
8. 锚通道伴名实验待办（N9 裁决）：伴名位不进 Tag 河道规格——等实测一对候选伴名的 A 增量（R_A 半衰修复是必要非充分，动态阈值 mean+2σ 与 A 的 union 才决定过线）
