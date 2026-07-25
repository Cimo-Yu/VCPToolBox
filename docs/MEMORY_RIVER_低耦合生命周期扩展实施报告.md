# Memory River 低耦合生命周期扩展实施报告

> 更新日期：2026-07-24  
> 当前实现范围：上游 RiverMemo 检索内核 + 本地 River 隔离配置、独立投影与生命周期事件。本地扩展不介入检索、排序或 TagMemo 语义链。

## 1. 背景与目标

旧版 VCP2 的 Memory River 同时接入了 KnowledgeBaseManager（KBM）、TagMemo、RAG、Flow、Query Cognitive Field、候选证据、排序、Ledger、管理 API 和前端工作台。该实现拥有较多能力，但本地逻辑直接进入上游核心链。每次上游演进 TagMemo、Rust/Vexus、检索或 RAG 流水线时，都需要重新适配大量本地修改。

当前仓库 `D:\vcp\VCPToolBox` 已升级到包含 TagMemo V10 与 Rust/Vexus 一体化演进的上游版本。本轮改造的目标不是恢复旧版完整 Memory River，而是建立一个可长期维护的低耦合边界：

1. 上游继续独占 KBM 事实源、向量、TagMemo V10、RiverMemo、RAG 和排序；
2. LightMemo 默认以 `enginemode=rivermemo` 进入上游 Rust/Rayon Topology V3 路径，本地不包装、替换或切分该搜索路径；
3. 本地 River 仅维护独立、可删除并重建的文件投影与生命周期状态；
4. 上游核心只认识通用的知识生命周期事件，不认识本地 River 投影业务；
5. 后续同步上游时，兼容工作收敛到少数稳定挂载点与事件契约；
6. 前端将分开消费上游 RiverMemo 的正式只读结果/诊断（若提供）和本地扩展的生命周期数据。

## 2. 当前架构

### 2.1 数据所有权

```text
日记文件
   │
   ▼
KBM SQLite：files / chunks / tags / file_tags        ← 上游唯一事实源
   │
   ├── LightMemo（默认 rivermemo）
   │     └── TagMemo V10 / RiverMemo / Rust-Rayon Topology V3 / RAG
   │           ← 完整采用上游检索与排序实现
   │
   └── versioned knowledge lifecycle event
            │
            ▼
Memory River Extension SQLite                        ← 本地可重建投影
  ├── memory_river_events
  └── memory_river_files
```

River 不反向写入 KBM 的主表、索引、TagMemo V10、RiverMemo 数据或 RAG 候选。删除 River 的独立 SQLite 后，可以重新扫描 KBM `files` 表建立投影。本地配置中的 `memoryScope` 只表示投影身份，不是 TagMemo/RiverMemo 的检索 scope，也不得传入上游检索调用。

### 2.2 生命周期调用链

已接通的路径：

```text
KBM 成功写入
  └── knowledge.written
        └── KnowledgeLifecycleExtensionHost
              └── MemoryRiverExtension inbox
                    └── River projection = active

KBM 成功删除
  └── knowledge.deleted
        └── KnowledgeLifecycleExtensionHost
              └── MemoryRiverExtension inbox
                    └── River projection = source_deleted

DailyNoteManager organize 成功归档源文件
  └── knowledge.archived
        └── KnowledgeLifecycleExtensionHost
              └── MemoryRiverExtension inbox
                    └── River projection = archived
```

扩展事件采用 best-effort 模式：扩展加载、初始化、投递或处理异常均会被隔离和记录，不得回滚或中断 KBM 写入、删除和 DailyNote 整理操作。

### 2.3 事件契约

通用宿主接收和标准化以下事件：

```text
knowledge.written
knowledge.deleted
knowledge.moved
knowledge.archived
knowledge.replaced
```

事件的稳定字段为：

```js
{
  version: 1,
  eventId: 'uuid',
  type: 'knowledge.written',
  occurredAt: 'ISO-8601',
  source: {
    filePath: 'Diary/entry.md',
    diaryName: 'Diary',
    agentId: undefined,
    checksum: '...',
    revision: '...'
  },
  content: {
    text: '...',       // 仅写入事件需要
    metadata: {}
  }
}
```

`eventId` 是事件 inbox 的幂等键。重复投递不会重复创建 River 文件投影。

## 3. 已修改和新增的文件

### 3.1 上游兼容层：应长期保持最小化

| 文件 | 当前职责 | 后续适配规则 |
| --- | --- | --- |
| `KnowledgeBaseManager.js` | 创建、初始化、关闭通用生命周期扩展宿主；提供 `_publishKnowledgeLifecycleEvent()`；启动上游 RiverMemo | RiverMemo 初始化与 LightMemo 调用链完全跟随上游。仅保持中性宿主，不引入 `riverId`、投影 SQL 或本地 scope 到检索路径。 |
| `modules/knowledgeBase/ingestionPipeline.js` | 在 KBM 写入成功后发布 `knowledge.written`；在 KBM 删除成功后发布 `knowledge.deleted` | 保持“事实源事务和索引更新成功之后才发布”的时序。不要同步等待 River 投影或改变 RiverMemo 搜索。 |
| `Plugin/DailyNoteManager/daily-note-manager.js` | 在 `organize` 实际成功归档源文件后发布 `knowledge.archived` | 只从明确的业务成功路径发布。不要以 watcher 的 add/unlink 猜测归档或移动。 |
| `modules/extensions/KnowledgeLifecycleExtensionHost.js` | 版本化事件校验、扩展初始化、并行投递、异常隔离、关闭 | 这是唯一通用扩展宿主。将来新扩展应实现同一接口，禁止在 KBM 中新增扩展专属判断。 |
| `modules/extensions/loadKnowledgeLifecycleExtensions.js` | 根据环境变量加载 CommonJS 扩展工厂 | 仅负责加载 `createKnowledgeLifecycleExtension(options)`，不得导入 River 实现。 |

### 3.2 本地 River 扩展：后续功能应主要落在这里

| 文件 | 当前职责 | 后续建议 |
| --- | --- | --- |
| `extensions/memory-river/index.js` | Registry 读取、独立 SQLite schema、事件 inbox、投影状态转换、drain、查询投影 | 将 outbox 重试、dead-letter、统计、读模型和配置校验继续拆分到此目录；不得试图接管或设置上游 RiverMemo 的搜索作用域。 |
| `extensions/memory-river/config/memory-rivers.example.json` | River 配置格式样例 | 真实 `memory-rivers.json` 为本机运行配置，不应提交。 |
| `extensions/memory-river/scripts/rebuild-memory-river.js` | 从 KBM SQLite `files` 表重新入队并重建投影 | 只读 KBM 数据库。扩展新的重建选项时必须维持只读事实源原则。 |

### 3.3 当前测试

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/knowledge-lifecycle-extension-host.test.js` | 事件标准化、扩展异常隔离、初始化与关闭行为、KBM 发布异常隔离 |
| `tests/knowledge-lifecycle-extension-loader.test.js` | 扩展工厂加载、相对路径解析、错误模块跳过 |
| `tests/memory-river-extension.test.js` | 配置匹配、写入投影、删除状态、移动状态、未配置日记跳过 |
| `tests/memory-river-isolation.test.js` | River 扩展错误不影响生命周期宿主成功返回 |
| `tests/memory-river-rebuild.test.js` | 从 KBM `files` 表重建 River 投影 |
| `tests/daily-note-memory-river-lifecycle.test.js` | DailyNote organize 归档事件发布 |

## 4. 当前能力边界

### 已实现

- River 配置：`riverId`、`memoryScope`、关联 diary、enabled；
- River 独立 SQLite：`memory_river_events` 和 `memory_river_files`；
- 幂等 inbox：相同 `eventId` 不重复处理；
- 文件投影状态：`active`、`source_deleted`、`moved`、`archived`、`replaced`；
- KBM 写入与删除事件；
- DailyNote organize 的归档事件；
- 扩展异常隔离；
- 从 KBM `files` 表进行投影重建；
- 15 项自动化测试通过（截至本报告更新时）。

### 明确未实现

以下能力不能在本轮被视为已迁移：

- TagMemo scope 隔离、旧版 Tag 向量复制、EPA、Residual、Geodesic 的本地适配；
- 旧版 Query Cognitive Field、Flow、候选证据、River 检索或排序包装；
- Virtual Union、Grant/Capability、Council、Workspace、Leader 协作；
- 秩币、Ledger、旧版 River Admin API、旧版语义地形；
- VCP2 Chat 的 Electron 窗口、IPC 依赖和 `/memory-river-v2/*` API。

### 上游 RiverMemo 已采用

当前上游的检索主线已经具备完整 RiverMemo：

- `Plugin/LightMemo/LightMemo.js` 的 `enginemode` 默认解析为 `rivermemo`；
- `rivermemo` 分支调用 KBM 的 `rerankWithRiverMemoAsync()`，使用 Rust/Rayon Topology V3；
- `KnowledgeBaseManager.js` 在启动时创建 `TagMemoV10Engine` 与 `RiverMemoEngine`，并维护对应 artifact；
- `rag_params.json` 的 `KnowledgeBaseManager.riverMemo.enabled` 已设为 `true`。

这条路径属于上游。后续更新时应直接同步其 LightMemo、RiverMemo、TagMemo V10、Rust/Vexus 与配置演进；不得把 VCP2 中绑定旧 TagMemo 搜索路径的 `memoryScope`、QCF、Flow 或排序适配重新移植回来。


## 5. 后续上游同步的适配方式

### 5.1 例行同步后先检查的文件

同步上游后，优先检查以下五处，而不是先检查 TagMemo/RAG：

```text
KnowledgeBaseManager.js
modules/knowledgeBase/ingestionPipeline.js
Plugin/DailyNoteManager/daily-note-manager.js
modules/extensions/KnowledgeLifecycleExtensionHost.js
modules/extensions/loadKnowledgeLifecycleExtensions.js
```

检查重点：

1. KBM 写入成功的边界是否仍在 `ingestionPipeline._flushBatch()` 中；
2. KBM 删除成功的边界是否仍在 `ingestionPipeline._handleDeleteBatch()` 中；
3. `KnowledgeBaseManager.initialize()` 与 `shutdown()` 是否仍能初始化和关闭通用宿主；
4. DailyNote organize 是否仍在实际成功移动源文件后返回；
5. 发布事件是否仍在上游事实源成功之后，而不是文件 watcher 观察到变化时。

### 5.2 新增业务生命周期时的落点

| 新需求 | 应修改的位置 | 不应修改的位置 |
| --- | --- | --- |
| 明确的文件移动命令 | 执行 `rename/copy+unlink` 且确认成功的业务模块；发布 `knowledge.moved` | watcher 回调、TagMemo、RAG |
| 明确的内容替换命令 | 知道旧文件被业务替换的命令完成点；发布 `knowledge.replaced` | 所有普通 KBM 写入路径 |
| 新 River 生命周期状态 | `extensions/memory-river/index.js` 的状态映射和投影存储 | KBM schema、TagMemo schema |
| 重试、dead-letter、统计 | `extensions/memory-river/` 内部 schema/worker/读模型 | `KnowledgeBaseManager.js` |
| River 管理 API | 新建 `routes/admin/memoryRiverExtension.js` 等独立路由，并调用扩展服务 | 旧 `memory-river-v2` 路由、RAG 路由 |
| River 管理前端 | `AdminPanel-Vue` 的 Vue 路由、API client 和页面组件 | VCP2 Chat 的 Electron HTML/IPC 原样复制 |

## 6. 前端适配策略

### 6.1 VCP2 Chat 前端的可复用范围

`D:\vcp2\chat\Memomodules\memory-river.html`（河流工作台）和 `D:\vcp2\chat\Memomodules\MemoryBook\memory-book.html`（世界书）可以作为视觉和交互参考，但不能原样迁入。

原因：这两个页面是 Electron 独立窗口，依赖 `utilityAPI` / `electronAPI`、VChat 设置、旧版 `/memory-river-v2/*` API、Ledger、旧 Flow/Terrain、Council 和 Workspace。当前前端应分开对接上游 RiverMemo 已提供的正式只读结果/诊断，以及本地生命周期扩展 API。

可复用内容：

- 河流工作台的三栏信息布局、河流列表、状态摘要、投影文件列表、筛选和刷新模式；
- 世界书的“River / 日记选择 + 正文阅读 + 侧边生命周期信息”布局；
- 视觉层级、中文文案、空状态、加载状态和交互组织。

必须删除或重新实现的内容：

- 真实语义地形 Canvas、Tag/Residual 边、旧 Flow journey、秩币诊断；
- Leader、Workspace、Round、Council、协作和授权能力；
- 对 VCPChat IPC、`utilityAPI`、Electron titlebar 的依赖；
- 对旧 `/memory-river-v2/*` API 的调用。

上游 RiverMemo 的正式结果或诊断若需要前端展示，应通过当前上游提供的 API/返回字段接入；不要把旧版 Canvas、Flow 或 scope 控制层复制为新的检索适配层。

### 6.2 推荐的当前前端归属

前端应迁入 `D:\vcp\VCPToolBox\AdminPanel-Vue`，而不是复制到 VCP2 Chat 的 Electron 窗口。

建议的两个页面：

1. **河流工作台**
   - River 配置和启用状态；
   - diary 关联；
   - 各状态的投影文件数量；
   - 文件投影表和状态筛选；
   - pending/complete/retry/dead-letter 事件列表；
   - 从 KBM 重建投影操作。

2. **世界书**
   - River 与 diary 选择；
   - 复用当前日记 API 浏览正文；
   - 显示该文件的 River 投影状态和生命周期记录；
   - 任何“收录”动作应调用日记写入接口，然后等待 KBM 生命周期扩展生成投影；前端不得直接写 River SQLite。

### 6.3 VCPChat 河流工作台接入进展（2026-07-24）

河流工作台前端已迁入 `D:\vcp\VCPChat`，而非本仓 `AdminPanel-Vue`。它是 VCPChat 的 Electron 独立子窗口，负责登记和观察本地 River 的配置/生命周期状态；VCPToolBox 保持 Registry 与生命周期投影的后端职责。

#### 前端文件与入口

```text
VCPChat/Memomodules/memory-river-console.html
VCPChat/Memomodules/memory-river-console.css
VCPChat/Memomodules/memory-river-console-api.js
VCPChat/Memomodules/memory-river-console.js
```

窗口通过 VCPChat 的 `WINDOW_APP_IDS.MEMORY_RIVER_CONSOLE`、`desktopHandlers` 和 `open-memory-river-console-window` IPC 注册，并在 VCPChat 托盘中以“河流”入口打开。

工作台当前提供以下分区：

| 分区 | 职责 |
| --- | --- |
| 总览 | 显示 Principal、Diary、River、待处理生命周期事件数量 |
| 人物 | 从 VCPChat 已注册 Agent 登记 Principal |
| 日记 | 为真实日记文件夹指定唯一 Owner Principal |
| 河道 | 创建 River，并选择其投影的 Diary |
| 授权 | 创建 Principal 对 River 的 `read_own`、`observe`、`contribute`、`steward` 授权 |
| 生命周期 | 按 River 浏览独立投影 SQLite 中的文件和状态 |

人物列表必须直接使用 VCPChat 的 `get-agents` IPC，不得通过 VCPToolBox 另建 Agent/人格目录。工作台选择 Agent 后，稳定 Principal ID 规范为 `vcpchat:<agentId>`；显示名取 VCPChat Agent 配置中的名称，模型名仅供界面展示。

#### VCPChat 与 VCPToolBox 的管理 API 契约

VCPChat 使用已有 `loadSettings()`、`loadForumConfig()` 取得 VCP 服务地址和管理员 Basic Auth 凭据。工作台访问的根路径固定为：

```text
http://<VCP host>:6015/admin_api/memory-river-extension
```

端口默认是 VCPToolBox 主服务端口 `6015`，可由 VCPChat 设置中的 `vcpToolboxPort` 或 `toolboxPort` 覆盖。不得从聊天补全 URL 的端口直接推导管理 API：聊天接口可能位于 `3100`，会导致工作台请求 `/admin_api/memory-river-extension/*` 返回 HTTP 404。

当前 API：

```text
GET  /overview
GET  /principals
POST /principals
PUT  /principals/:id
GET  /diaries
POST /diaries
PUT  /diaries/:id
GET  /rivers
POST /rivers
PUT  /rivers/:id
GET  /grants
POST /grants
PUT  /grants/:id
GET  /rivers/:riverId/projections
GET  /events
POST /migrate-v1
POST /rebuild
```

所有接口受既有 `/admin_api` 管理认证保护。若 VCPChat 页面显示 HTTP 401，说明接口可达但 `forumConfig.username/password` 或 `settings.adminUsername/adminPassword` 未配置正确；HTTP 404 则优先检查是否请求到了错误端口或旧页面缓存。

#### Registry v2：长期配置事实源

本地配置文件为：

```text
extensions/memory-river/config/memory-rivers.v2.json
```

结构为：

```json
{
  "version": 2,
  "principals": [],
  "diaries": [],
  "rivers": [],
  "grants": []
}
```

关系和约束：

```text
Principal（VCPChat Agent）
  -> 拥有 Diary
     -> Diary 投影到一个或多个 River
        -> Principal 获得 River grant（read_own 等）
```

- 同一物理 Diary 文件夹只能有一个 Owner Principal；重复登记必须被后端拒绝。
- 一个 Diary 可以投影到多个 River；一个 River 可投影多个 Diary。
- 配置通过临时文件加重命名原子写入，因此重启 VCPChat/VCPToolBox 后仍能读取同一份事实源。
- `read_own` 的语义是：主体拥有该 Diary、Diary 已投影到目标 River、且主体拥有该 River 的 `read_own` grant。

#### 生命周期对齐

`MemoryRiverExtension` 仍拥有自己的事件 inbox 和 SQLite 投影：

```text
extensions/memory-river/data/memory-river.sqlite
memory_river_events
memory_river_files
```

Registry v2 配置文件存在时，扩展以 `Diary -> Registry v2 -> enabled Rivers` 决定事件落到哪些本地 River；不存在时才兼容旧 `memory-rivers.json` 映射。生命周期状态包括：`active`、`source_deleted`、`moved`、`archived`、`replaced`。

该投影不反向写 KBM 事实表、TagMemo、RiverMemo、Rust/Vexus 或 RAG 请求。`memoryScope` 只用于本地投影的稳定身份，禁止作为上游检索 scope 传入任何上游模型链。

#### 验证状态

截至本节更新，以下 Node 测试通过：

```text
14 / 14
```

覆盖 Registry 跨实例持久化、唯一 Diary 所有权、Diary -> River 映射、`read_own` 校验、Registry v2 生命周期投影、写入/删除/归档/移动状态、只读 KBM 重建、扩展异常隔离与加载器兼容。

`rag_params.json` 中的 `KnowledgeBaseManager.riverMemo.enabled=true` 仅启用上游全局 RiverMemo/TagMemo/Rust-Vexus 检索链。当前工作台登记的 River 不会自动创建“每 River 独立 Tag 模型”，也不会改变上游 RiverMemo 排序；若未来需要 River Tag Profile，必须在扩展自己的配置/SQLite 中实现并保持该边界。

### 6.4 前端前必须补齐的独立 API

当前后端扩展还没有提供管理前端 API。应先为扩展建立独立路由，例如：

```text
GET  /admin_api/memory-river-extension/rivers
GET  /admin_api/memory-river-extension/rivers/:riverId/projections
GET  /admin_api/memory-river-extension/events
GET  /admin_api/memory-river-extension/config
PUT  /admin_api/memory-river-extension/config
POST /admin_api/memory-river-extension/rebuild
```

这些路由只能访问 `extensions/memory-river` 的配置和 SQLite，不得依赖 TagMemo、RAG 或旧版 `memory-river-v2` 路由。

## 7. 运行配置与重建

### 7.1 启用扩展

在实际 `config.env` 中设置：

```env
KNOWLEDGE_LIFECYCLE_EXTENSION_MODULES=./extensions/memory-river
MEMORY_RIVER_CONFIG_PATH=./extensions/memory-river/config/memory-rivers.json
MEMORY_RIVER_DATABASE_PATH=./extensions/memory-river/data/memory-river.sqlite
```

然后基于 `extensions/memory-river/config/memory-rivers.example.json` 创建本机配置：

```json
{
  "version": 1,
  "rivers": [
    {
      "id": "my-river",
      "memoryScope": "river:my-river",
      "diaries": ["日记本名称"],
      "enabled": true
    }
  ]
}
```

`memoryScope` 在当前版本只是 River 投影的稳定身份；它不是上游 TagMemo V10、RiverMemo、Rust/Vexus 或 RAG 的检索作用域，禁止把它传入这些调用。

### 7.2 重建投影

扩展数据库可从 KBM 的 `files` 表重建：

```bash
node extensions/memory-river/scripts/rebuild-memory-river.js \
  VectorStore/knowledge_base.sqlite \
  extensions/memory-river/config/memory-rivers.json \
  extensions/memory-river/data/memory-river.sqlite
```

脚本以只读方式打开 KBM SQLite，只写入 River 扩展自己的数据库。

## 8. 后续验证清单

### 8.1 真实环境冒烟验证

尚未在真实运行数据上执行，必须在启用扩展后验证：

- [ ] 用 LightMemo 默认 `enginemode=rivermemo` 执行真实查询，确认 RiverMemo Rust/Rayon Topology V3 成功返回结果；
- [ ] 确认 `KnowledgeBaseManager.riverMemo.enabled=true` 在重启后按上游预期生效，并记录 artifact 恢复或构建日志；
- [ ] 验证本地 River 生命周期扩展的 `memoryScope` 没有进入 LightMemo、TagMemo V10、RiverMemo 或 RAG 请求；
- [ ] 新建或编辑受管理 diary，KBM 写入成功后 River 表出现 `active` 投影；
- [ ] 删除受管理 diary，投影变为 `source_deleted`；
- [ ] DailyNote `organize` 成功后，投影变为 `archived`；
- [ ] 未配置 diary 不产生 River 投影；
- [ ] 禁用 River 后，新事件不产生投影；
- [ ] 同一 event 重复投递时不产生重复投影；
- [ ] River SQLite 暂时不可用时，KBM 与 DailyNote 操作仍正常完成；
- [ ] 恢复 River SQLite 后，pending 事件可被处理；
- [ ] 删除 River SQLite 后，重建脚本能从 KBM 恢复正确投影。

### 8.2 生产可靠性增强

当前 inbox 已持久化 pending 事件，但尚未完成长期运行所需的 worker 能力：

- [ ] 启动时自动 drain pending 事件；
- [ ] 持续或定时消费 pending 事件；
- [ ] 可配置重试间隔、最大次数和关闭等待预算；
- [ ] 达到最大次数后写入 dead-letter 状态；
- [ ] 提供 dead-letter 查询与人工重放；
- [ ] 关闭时停止接收新事件并确保未完成事件已落盘；
- [ ] 提供扩展健康状态和基础计数，供 API/前端读取。

### 8.3 上游兼容性回归

每次同步上游后至少执行：

```bash
node --test \
  tests/knowledge-lifecycle-extension-host.test.js \
  tests/knowledge-lifecycle-extension-loader.test.js \
  tests/memory-river-extension.test.js \
  tests/memory-river-isolation.test.js \
  tests/memory-river-rebuild.test.js \
  tests/daily-note-memory-river-lifecycle.test.js

node --check KnowledgeBaseManager.js
node --check modules/knowledgeBase/ingestionPipeline.js
node --check Plugin/DailyNoteManager/daily-note-manager.js
```

还应运行：

```bash
git -c core.whitespace=cr-at-eol diff --check
```

该仓库部分文件使用 CRLF，因此使用该命令避免把行尾 CR 误判为新增行尾空白。

## 9. RiverMemo 演进：从统一全局图到 River 级全局图

### 9.1 当前上游检索事实

当前 LightMemo 已默认使用上游 RiverMemo：

```text
LightMemo（未传 riverId）
  └── enginemode 默认 rivermemo
        └── KBM rerankWithRiverMemoAsync()
              └── TagMemo V10 + Rust/Rayon Topology V3
```

当前上游 RiverMemo 的实际分层必须准确区分：

```text
候选域
  └── LightMemo 按 maid / folder / search_all_knowledge_bases 收集 diary chunk
        └── allowedFileIds 传入 RiverMemo，限制最终可返回候选

拓扑域
  └── 全局 tags.vector / 全局 Tag 图 / 单份 V10-RiverMemo artifact
        └── Rust/Rayon 在全局拓扑上计算连续场与 Topology V3
```

因此，当前结果候选可以按 diary 收窄，但 Tag 图、首跳、连续场与 artifact 仍是整个 KBM 的统一全局 RiverMemo。它不是“每个本地 River 一张独立全局图”。

### 9.2 已完成的 RiverMemo 运行时修复

启用 `KnowledgeBaseManager.riverMemo.enabled = true` 后，曾出现 Rust 调用引用已被 artifact 保留策略退休的签名：

```text
RiverMemo artifact <artifactSig> unavailable: Query returned no rows
```

根因是运行时仍持有 `retired` artifact，而 Rust worker 只允许读取 `status = ready` 的持久化 artifact。

`RiverMemoEngine.js` 已增加受限恢复：当且仅当收到 artifact unavailable/retired 的明确错误时，失效当前内存 artifact，重新取得 ready artifact 并重试一次。它不会对拓扑超时、参数错误或其他普通 RiverMemo 错误重试，更不会手工把 retired artifact 改回 ready。

对应测试：`tests/river-memo-artifact-recovery.test.js`。

### 9.3 目标语义：每条 River 都是一张独立全局图

后续目标不是恢复旧版 `memoryScope` 绑在 TagMemo 搜索路径上的机制，而是让显式 River 查询拥有自己的上游原生 RiverMemo 数据域：

```text
KBM 事实源
  ├── River A 的关联 diary 集合
  │     └── River A 独立 Tag 图 / V10 artifact / Rust RiverMemo runtime
  ├── River B 的关联 diary 集合
  │     └── River B 独立 Tag 图 / V10 artifact / Rust RiverMemo runtime
  └── 同一 diary 可同时属于 A、B，但分别参与两个 River 的独立图构建
```

共享的是 KBM 权威文件、chunk 和 `tags.vector` 语义坐标；隔离的是每个 River 的 file/tag membership、图连接、场、artifact、缓存与最终候选域。相同 Tag 在两条 River 中可共享向量值，但不得因此共享 River 图。

### 9.4 已确认的产品策略

| 请求 | 目标行为 |
| --- | --- |
| LightMemo 不带 `riverId` | 完全保留上游统一 global RiverMemo；不改变现有工具、RAG 或 Human Toolbox 调用。 |
| LightMemo 带 `riverId` | 仅检索该 River 的关联 diary，并最终使用该 River 独立 artifact。 |
| River 未知、禁用或没有 active 文件 | fail closed，返回 River 专属错误或空结果；不回退到 global。 |
| `folder` / `maid` 与 River 同时传入 | 只能取交集；不得扩张 River diary 范围。 |
| 一篇 diary 属于多条 River | 允许；它分别进入每条 River 的独立构建域。 |

### 9.5 后续实施顺序

此项必须作为独立子项目推进，不能直接把当前生命周期扩展的 `memoryScope` 传入上游 LightMemo：

1. **候选域先行**：新增显式 `riverId`，以本地 Registry 解析 active diary 集合；严格限制候选到 River 内，并将结果标记为 `river-candidate-scoped`。该阶段不宣称拓扑隔离。
2. **上游构建能力审计**：验证 V10/RiverMemo 能否从只读的 River files / file_tags / tags.vector 快照构建独立 artifact，且不写 KBM 全局表、不改变全局 runtime。
3. **独立 artifact**：仅在审计成功后，新增 `RiverMemoScopeAdapter`、`RiverArtifactBuilder`、repository、LRU runtime cache 与 stale job；Rust runtime cache key 必须带 River artifact 身份。
4. **生命周期失效**：本地 `knowledge.written`、`deleted`、`archived`、`moved`、`replaced` 投影成功后只标记关联 River artifact stale；不影响上游 global RiverMemo。

若阶段 2 证明上游没有可维护的 domain-scoped artifact builder，必须停在严格候选隔离，不得用旧 scope、全局 artifact 或 monkey-patch 伪装为 River 级图隔离。

### 9.6 River 级图的后续验证

- [ ] global LightMemo 不带 `riverId` 的结果与当前上游行为一致；
- [ ] River A 请求不能返回 River B 独有 diary 的 chunk；
- [ ] 同一 diary 同时归属 A/B 时，能分别在两条 River 中检索；
- [ ] folder/maid 只能收窄 River，而不能扩大 River；
- [ ] River A 的写入、删除或归档只使 A 的 artifact stale，不影响 B 或 global；
- [ ] River A、River B 与 global 的 runtime/artifact cache key 不冲突；
- [ ] River artifact 构建全过程只读 KBM；
- [ ] retired River artifact 只换到同一 River 的 ready artifact，绝不跨 River 或回退 global；
- [ ] 真实语料完成 A/B 交叉泄漏、召回质量、artifact 构建时间与查询延迟验证。

## 10. 结论

本轮已经把 Memory River 从旧版“同时侵入上游检索与排序主链”的方案，收缩为“通用生命周期扩展宿主 + 独立 River 投影”的方案；同时确认当前上游 RiverMemo 是统一 global 图，并为下一阶段的显式 `riverId`、候选隔离和最终 River 级独立全局图确定了不回退旧 scope 的演进路径。

后续开发必须坚持两条规则：

1. 本地生命周期、投影与管理逻辑优先放在 `extensions/memory-river/`；
2. 上游 RiverMemo 检索内核直接跟随 LightMemo、TagMemo V10 与 Rust/Vexus 的上游实现；本地只能在少量事实源成功后的通用事件挂载点维护投影，不能重新耦合旧 TagMemo scope、QCF、Flow 或排序。

在真实环境通过生命周期冒烟测试、RiverMemo artifact 自动恢复、自动恢复/dead-letter、API/前端验证，以及 River 级图隔离验证前，当前实现应视为“代码与自动化测试通过的基础版本”，不应宣称为完整生产验收。
