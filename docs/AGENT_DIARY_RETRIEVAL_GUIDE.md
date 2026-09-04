# Agent 日记召回指南

怎么让 Agent 文件里的日记声明**真的被检索到**。

本文来自 2026-08-10 的一次生产事故：纸子连续多轮自动记忆注入全空。事故本身不难修（一行占位符），
但排查过程暴露了三条互相独立的静默失败路径 —— 三条都不报错、不告警、日志里只是少了几行，
所以只靠"看起来配好了"是发现不了的。本文把这三条路径和验证手段固定下来。

所有结论均标注了源码行号。数值结论来自只读探针实测，日志结论来自 `DebugLog/ServerLog.txt`；
凡是只由源码推出、线上尚未观测到的（§2 里 B 的几种签名），文中都单独注明。

---

## 目录

1. [一句话规则](#1-一句话规则)
2. [三种静默失败](#2-三种静默失败)
3. [标准写法](#3-标准写法)
4. [修饰器怎么选](#4-修饰器怎么选)
5. [新增 / 修改 Agent 的检查清单](#5-新增--修改-agent-的检查清单)
6. [怎么验证](#6-怎么验证)
7. [当前全库审计结果](#7-当前全库审计结果)
8. [附：门控为什么不可达](#8-附门控为什么不可达)

---

## 1. 一句话规则

```
[[X日记本::RiverMemo]]
```

无门控、走 RiverMemo 拓扑测地线排序。**不要用 `《《》》` 或 `<<>>`，不要加 `::Rerank+`。**

前者在本部署永久关闭（§8），后者是空转（§4）。

---

## 2. 三种静默失败

三种都表现为"零注入且无报错"，但日志签名不同，别混：

| # | 失败模式 | 日志签名 | 是否会自愈 |
|---|---------|---------|-----------|
| A | Agent 文件里**没有**日记声明 | `Total processing promises: N`，N 只等于其余占位符数（纸子当时 N=1，那 1 个是元思考） | 不会 |
| B | 用了 `《《》》` / `<<>>`，被相似度门控挡掉 | `《《》》` 留一行 `"X" similarity (0.4xxx) below threshold (0.6). Skipping RAG.`；`<<>>` **一行都不打** | 不会 |
| C | `dailynote/<日记本名>` 目录不存在或为空 | 计数正常，无 threshold 行，也无 `🌊 RiverMemo:` 行 | 首次写入后自愈 |

关键区分点：

- **`promises` 计数只能区分 A 和「B 或 C」**。`《《》》` 和 `[[ ]]` 各推入一个 promise，计数一样。
  事故当天 8 轮全是 `promises: 1`，这就证明了是 A（声明整个缺失），不是门控问题。
- **B 的两个分支静默程度不同**。`《《》》` 未达阈值时至少打一行（:2026）；
  `<<>>` 直接 `_setCachedResult('')` 后 `return`，**没有任何日志**（:1843-1848）。
  所以 `<<>>` 的失败在日志里**和 C 无法区分** —— Nova 的 `<<VCP开发日记本>>` 正是这种，只能靠审计脚本发现。
- **B 的空结果会被写进缓存**（:1847 / :2028）：`return { placeholder, content: '' }` 并 `_setCachedResult`。
  **不会降级为 RAG 片段**，是整体不注入；同一请求内后续命中缓存会连阈值判断都跳过（:1808-1811）。
- **门控还有第三种签名**：`_getDiarySimilarityCached` 拿不到名向量时打
  `Could not find cached vector for diary name: "X". Skipping.`（:1818 / :1975）。
  当前 `kv_store` 只有 9 条 `diary_name:` 向量，`媒介与转译`/`条件与交付`/`艺术史与接受`/`场与层级`/`实践与训练`
  都不在其中 —— 这 5 条门控声明走的是这条路，不是 `below threshold`。
- **B 签名已获线上实测样本（2026-08-11，4 次，全部来自 `公共的逻辑学与哲学`）**：
  `"公共的逻辑学与哲学" similarity (0.3947/0.4994/0.4325/0.4042) below threshold (0.6). Skipping AIMemo.`
  —— 数值与 §8 预测的 0.4~0.5 水位完全吻合。`Could not find cached vector` 仍为 0 次。
  初版文档里这两个签名都无线上样本、只能靠源码推出；现在 B 有了实证。
- **C 对新 agent 是正常状态** —— 日记目录在首次 DailyNote 写入时才创建。
  但如果同时犯了 B，等日记写出来了照样召不回：C 会自愈，B 不会。所以新 agent 也要先把语法写对。
- **反向印证**：唯一稳定工作的 `纸子的知识` **根本没有名向量**（不在上面那 9 条里）。
  `[[ ]]` 不需要它，因为路上没有相似度比较。

---

## 3. 标准写法

记忆区照这个形状写（当前 `Agent/Zhizi.txt` 即是）：

```
————VCP元思维模块————
[[VCP元思考::Group]]
————VCP元思考加载结束—————
这里是[纸子的知识]日记本，你唯一的写入地：[[纸子的知识日记本::RiverMemo::Time]]
————————以上是过往记忆区————————
```

`::Time` 是 2026-08-11 的决定：RiverMemo 的 Ω 排序不带时效信号，新写入的日记在图谱外围，
稠密态下会被选择阶段裁掉（当天实测 11 轮只有 4 轮注入过 8/10-8/11 内容，sparse 态 3/3 全中、
dense 态 8 轮只中 1 轮）。`::Time` 补一条时间路（默认 80/20 比例，`::Time0.1`-`::Time0.9` 可调），
让近期内容有机会进上下文。代价是新对话开头可能被近期记忆主导 —— 这是口味取舍，不是修复。

命名约束：

- 占位符里的名字 **必须等于** `dailynote/` 下的目录名。解析正则 `/\[\[(.*?)日记本(.*?)\]\]/`
  取的是"日记本"二字之前的部分，所以 `[[纸子的知识日记本::RiverMemo]]` → 目录 `dailynote/纸子的知识`。
- **日记本名里别含"知识库"**。冷知识库语法 `/\[\[(.*?)知识库(.*?)\]\]/` 会命中同一串，
  虽然有 `isDiaryPlaceholderAmbiguity` 兜底（`RAGDiaryPlugin.js:1551`），但从源头避开更省事。
- 多个日记本用 `|` 合并：`[[公共的日常|公共的知识日记本::RiverMemo]]`，每一段都要各自对应一个目录。
- 一个日记本只由一个 agent 写入。这是拓扑要求（曲线连贯性），代码层面不做强制。

---

## 4. 修饰器怎么选

| 修饰器 | 状态 | 说明 |
|--------|------|------|
| `::RiverMemo` | **推荐** | 拓扑测地线排序。前提是 `rivermemo_artifacts` 里有 `status='ready'` 的产物（当前 106 条，最新 524 节点 / 8136 边）。日志会打 `🌊 RiverMemo: offered=N, ranked=N, returned=K, Ω=…, regime=…` |
| `::Time` / `::Time0.x` | **推荐叠加** | 时效补充召回（`useTime` 开关，默认 80/20 时间路比例，`::Time0.1`-`::Time0.9` 显式调）。2026-08-11 起纸子启用 —— Ω 排序无时效信号，新写入的日记在图谱外围，稠密态下会被选择阶段裁掉（§3 有实测）。代价：新对话可能被近期内容主导 |
| `::Rerank` / `::Rerank+` | **空转，已全库移除** | 需要外部 rerank 服务。`_rerankDocuments`（`RAGDiaryPlugin.js:4102`）JIT 检查 `url && apiKey && model`，本部署 `config.env` 一个 `Rerank*` 键都没有 → 打 `Rerank called, but is not configured. Skipping.` 后降级成 `documents.slice(0, K)`。2026-08-11 连 8 个维度 agent 一起清理，全库 `Agent/` 已无 `::Rerank`（有回归测试防回潮） |
| `::RoleValve@…` | 慎用 | 不满足条件时直接 `content: ''` 并 `continue`（:1739）。不写 `::RoleValve` 时默认放行（:1095） |
| `::AIMemo[:x]` | 需要许可证 | 只有系统提示里存在 `[[AIMemo=True]]` 才生效，否则整个修饰器被忽略 |

`::Rerank+` 的附带代价：候选池会按 rerank 预期放大成 `finalK * rerankConfig.multiplier + dedupBuffer`（:2726），
多取多算完再被 slice 砍回 K。去掉它不损失召回质量 —— 排序本来就是 RiverMemo 做的。

`::Group` / `::Time` / `::TagMemo+` / `::Truncate` 等属于检索策略调参，
见 `docs/TAGMEMO_TUNING_GUIDE.md` 与 `rag_params.json`，不在本文范围。

---

## 5. 新增 / 修改 Agent 的检查清单

1. **`agent_map.json` 里有映射** —— `"显示名": "文件名.txt"`。客户端系统提示里只放 `{{显示名}}`，
   服务端 `messageProcessor.resolveAllVariables` 把它展开成 Agent 文件全文
   （`chatCompletionHandler.js:995`，在预处理器循环 :1040 **之前**，所以 RAGDiaryPlugin 扫到的是展开后的文本）。
2. **记忆区有日记声明**，且用 `[[ ]]`，不用 `《《》》` / `<<>>`。
3. **占位符里的名字 = `dailynote/` 下的目录名**，逐字相同（含"的"字）。
4. **不加 `::Rerank+`**。
5. **改完不用重启** —— chokidar 监听 Agent 目录，会打出
   `[AgentManager] Prompt cache for '<别名>' (<文件>) cleared due to file change.`，下一轮即生效。
6. **跑一遍审计** —— `node scripts/audit_agent_diary_declarations.js`（只读，可反复跑）。

---

## 6. 怎么验证

### 日志签名

一轮正常的召回长这样（2026-08-10 15:14:36 实测）：

```
[RAGDiaryPlugin] Total processing promises: 2
[RAGDiaryPlugin] 🌊 RiverMemo: offered=117, ranked=117, returned=20, Ω=0.5146, regime=dense
[RAGDiaryPlugin] ✓ Replaced placeholder: "[[VCP元思考::Group]]..." with 4681 chars
[RAGDiaryPlugin] ✓ Replaced placeholder: "[[纸子的知识日记本::RiverMemo::Rerank+]]..." with 20530 chars
```

（这一行照抄实测日志，当时还带着 `::Rerank+`；同一轮日志里另有一条
`Rerank called, but is not configured. Skipping.` —— 正是 §4 说的空转。修饰器已按 §3 去掉，
现在这行会显示为 `[[纸子的知识日记本::RiverMemo]]`。）

抽取命令（避开日志里 JSON `query` 字段中被引用的同名文本）：

```bash
grep -aoE '^\[[^]]*\] \[LOG\] \[RAGDiaryPlugin\] (Total processing promises: [0-9]+|✓ Replaced placeholder: "[^"]*"\.\.\. with [0-9]+ chars|🌊 RiverMemo: .*)' DebugLog/ServerLog.txt | tail -20
```

注意 `🌊 RiverMemo Topology V3` 这行也会出现在 `[LightMemo]` 前缀下 —— 那是主动工具调用路径，
和被动占位符注入是两条独立链路。判断被动链路是否跑了，**必须连日志前缀一起匹配**。

### 回归测试

```bash
node --test tests/agent-diary-placeholder-zhizi.test.js
```

8 个用例。它不抄正则，而是从 `RAGDiaryPlugin.js` 里把四种语法的正则本体抠出来用 ——
解析处一旦被改写，测试会失败而不是静默失效。其中一个是结构不变量：
断言 `[[ ]]` 分支区间内**没有** `finalSimilarity >=` 比较，同时断言 `<<>>` / `《《》》` 区间内**有**（对照组）。
谁给 `[[ ]]` 分支加门控，这道防线会拦下来。

### 全库审计

```bash
node scripts/audit_agent_diary_declarations.js
```

逐条列出所有 Agent 文件的日记声明，交叉核对语法可达性、`dailynote/` 目录存在性、向量化数量。

另有两个只读探针（可与线上服务共存）：

```bash
node scripts/probe_diary_index_warm.js [日记本名]    # 单个日记本的索引/产物健康度，默认 纸子的知识
node scripts/probe_rag_gate_reachability.js         # 复算门控阈值的实际可达率
```

---

## 7. 当前全库审计结果

2026-08-10 实测：**52 条声明，只有 10 条能召回。**

```
共 52 条声明，其中 42 条无法召回。
  B 门控语法        : 14 条（其中目录已就绪、仅被门控挡住: 1 条）
  C 目录缺失/未索引 : 41 条（其中语法本身没问题: 28 条）
  B ∩ C 同时中两条  : 13 条
```

B 和 C 会重叠，所以两栏加起来大于 42。

### 可召回（10 条）

| Agent | 日记本 | 语法 | 已向量化 |
|-------|--------|------|---------|
| Zhizi.txt | 纸子的知识 | `[[ ]]` | 123 |
| Metis.txt | 前思维簇 / 逻辑推理簇 / 反思簇 / 结果辩证簇 / 陈词总结梳理簇 | `{{ }}` | 8 / 10 / 7 / 6 / 7 |
| Nova.txt | Nova | `[[ ]]` | 4 |
| ThemeMaidCoco.txt | 可可的知识 | `{{ }}` | 2 |
| MemoMaster.txt | 记忆大师 | `[[ ]]` | 1 |
| Weiming.txt | 微明的知识 | `[[ ]]` | 1 |

`纸子的知识` 一个占了 `files` 表 189 条里的 123 条。事故期间零注入丢的就是这一整块。

本节所有计数都是 2026-08-10 的快照，会随每次日记写入增长（写这段期间就从 188/122 涨到了 189/123）。
**别把它们当常量引用，要现状就跑审计脚本。** 结构性结论（谁语法错、谁没目录）才是稳定的。

### 门控挡住（B，14 条）

**唯一一条"只差语法"的**：`Nova.txt` 的 `<<VCP开发日记本>>` —— 目录有 3 个文件、5 个 chunk 已向量化，
改成 `[[VCP开发日记本::RiverMemo]]` 即刻可召回。注意它属于 `<<>>` 分支，失败时**日志里一个字都不留**（§2），
所以这条不可能靠读日志发现，只能靠审计脚本。

其余 13 条同时中了 C（目录还不存在），改语法属于预防。8 个维度 agent 各自的"唯一写入地"
全部用了 `《《…::RiverMemo::Rerank+》》`：

| Agent | 日记本 | 实测最高相似度 |
|-------|--------|--------------|
| Ananke.txt | 理论与形式责任 | 0.4973 |
| Argus.txt | 观察与诊断 | 0.5476 |
| Maat.txt | 评议与修订 | 0.5853 |
| Cangjie.txt | 媒介与转译 | 无名向量 |
| Hephaestus.txt | 条件与交付 | 无名向量 |
| Mnemosyne.txt | 艺术史与接受 | 无名向量 |
| Nemesis.txt | 场与层级 | 无名向量 |
| PaoDing.txt | 实践与训练 | 无名向量 |

"无名向量"= `kv_store` 里没有对应的 `diary_name:` 条目，探针无从计算；运行时这 5 条走
`Could not find cached vector … Skipping.`（:1975）而非 `below threshold`。两条路径终点相同：`content: ''`。

另有 Nova/Weiming 的 `公共的逻辑学与哲学`（名向量最高 0.5357），Aemeath/Hornet/Nova 的 `MusicDiary`
（最高 0.6007，191 个 chunk 里仅 1 个过线 —— 见 §8，实质等于不可达）。
2026-08-11 线上已实测 `公共的逻辑学与哲学` 被门控挡了 4 次（0.3947~0.4994，§2），坐实了这一栏。

### 日记目录不存在或未索引（C，41 条）

`公共的日常`、`公共的知识`、`公共的逻辑学与哲学`、`MusicDiary`，以及上面 8 个维度日记本，
在 `dailynote/` 下都没有目录。这不是数据丢失 —— `dailynote/` 里旧命名方案的目录
（`阿南刻的知识`、`阿尔戈斯的知识`、`阿南刻的形式审查`、`阿里阿德涅的知识`、
`决策官日记本`、`审问官日记本`、`拆读员日记本`、`边界员日记本`、`VCP论坛`、`Ariadne材料库日记本`）
**全部是空目录**，说明这些 agent 的日记还从未写过。

**所以现在改语法是预防，等它们写出日记再改就是救火。** C 会在首次写入时自愈，B 不会。

### 一条待办

`dailynote/已整理` 有 3 个文件但没进索引，且没有任何 agent 声明它。归档目录还是索引遗漏，未查。

---

## 8. 附：门控为什么不可达

四种被动语法在 `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:1543-1547` 解析：

```js
const ragDeclarations       = [...processedContent.matchAll(/\[\[(.*?)日记本(.*?)\]\]/g)];      // 无门控
const fullTextDeclarations  = [...processedContent.matchAll(/<<(.*?)日记本(.*?)>>/g)];          // 单阈值门控 → 过关后走 {{ }} 纯文本管线
const hybridDeclarations    = [...processedContent.matchAll(/《《(.*?)日记本(.*?)》》/g)];      // 双阈值门控 → 过关后走 RAG
const directDiariesDeclarations = [...processedContent.matchAll(/\{\{(.*?)日记本(.*?)\}\}/g)];  // 纯文本直取
```

门控分支调 `_getDiarySimilarityCached`（:3824），它算的是：

```js
Math.max(
    cosineSimilarity(queryVector, embedding("理论与形式责任")),  // ← 日记本【名字那几个字】的向量
    cosineSimilarity(queryVector, enhancedVector)                // ← 由 rag_tags.json 的 tags 构建
)
```

（这里拿 `理论与形式责任` 举例而不是 `纸子的知识`：后者走 `[[ ]]`，根本不经过这段，
`kv_store` 里连它的名向量都没有。）

第一项比的**不是日记内容，是日记本名那 4~7 个字**。
第二项的 `enhancedVector` 由 `rag_tags.json` 构建（`_buildAndSaveCache`:348），
而本部署**没有这个文件**（启动日志明确 `未找到 rag_tags.json 文件`）→ `ragConfig = {}` → 第二项恒为 0。

于是门控退化成"查询 vs 裸名字符串"，再跟 `GLOBAL_SIMILARITY_THRESHOLD = 0.6`（:44）比。

实测（`scripts/probe_rag_gate_reachability.js`，9 个已缓存名向量 × 全部内容 chunk）：

```
达到 0.6 的配对: 4/1719 (0.23%)     全局最大 0.6770   名向量互相之间 avg=0.4037
```

那 4 个达标配对来自 `Ariadne日常`（3 个，max 0.6770）和 `MusicDiary`（1 个，0.6007，刚过线）。
两者都是"名字碰巧撞上某一个 chunk"，不是真实查询能复现的路径 ——
`MusicDiary` 是唯一有实际声明的那个，191 个 chunk 里只有 1 个够格，等于没有。
分母会随索引增长，比例和结论不变（几天前是 4/1710，同样 0.23%）。

长查询与一个短名串的余弦天然落在 0.4~0.5 区间，0.6 等于把开关焊死在 OFF。
**这个数跟你说什么无关，只跟日记本名字有关** —— 调修饰器、改写提示词都动不了它。

想真正用上 `《《》》`，必须二者之一：

- 补 `rag_tags.json`，给该日记本配 tags 把 `enhancedVector` 建起来；
- 或在 `ragConfig[dbName].threshold` 里给它单独调低阈值。

否则就用 `[[ ]]` —— 它直接进 `_processRAGPlaceholder`，路上只有 RoleValve 和 AIMemo 两个分叉，没有相似度比较。
