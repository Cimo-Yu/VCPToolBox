[2026-09-04 21:07] - Nova

# VCPBridgeServer — System Prompt 劫持代理（源码实证 · 2026-09-04）

## 核心概念
独立端口的透明 API 代理，用于给「前端不可改 system prompt」的 CLI 工具（Codex CLI / Claude Code / Cursor / Kiro）注入或替换人格与规范。pluginType=`service`，communication=`direct`，随主服务启动并跑在主服务进程内（实测 3100 与 6015 同属一个 PID）。

## 物理参数
- 目录：`Plugin/VCPBridgeServer/`（`bridgeserver.js` 41KB 路由与代理 / `bridgeConfig.js` 13KB 配置与 Profile CRUD / `bridge-config.json` 运行真相源 / `profiles/` / `presets/`）
- 端口：**3100**（README 全篇误写 6003）
- 真相源优先级：`bridge-config.json` > 本目录 `config.env` 迁移 > `config.env.example` > 代码 DEFAULT
- 热载：`bridge-config.json` 与 `profiles/` 均由 chokidar 监控。**端口变更需重启**，其余字段热载
- 健康检查：`GET /health` 返回 hijackMode / hasSystemPrompt / upstreamType / upstreamUrl / modelMap / configPath

## 全局配置字段（bridgeConfig.js DEFAULT_BRIDGE_CONFIG）
| 字段 | 默认 | 说明 |
|---|---|---|
| port | 3100 | 独立端口 |
| upstreamUrl | 空→`http://127.0.0.1:{PORT}` | 留空自动指向本机 VCP 主服务 |
| upstreamKey | 空→主服务 Key | 再回落到下游 Authorization Bearer |
| upstreamType | chat | chat / anthropic / gemini（别名 claude→anthropic, google→gemini） |
| defaultModel | gpt-4.1-mini | 下游未指定 model 时使用 |
| systemPrompt | 空 | 直接文本，或 `.txt` 文件名 |
| hijackMode | off | off / replace / prepend / append / merge |
| modelMap | {} | 别名→目标；文本形式支持 `a=b` 与 `a:b` 两种分隔 |
| debugMode | false | |
| defaultProfile | 空 | **已知失效，见「已知缺陷」** |

## 劫持模式语义（bridgeserver.js:640-660）
- `replace` — 滤掉全部原 system，注入置顶
- `prepend` — 注入置顶，原 system 保留
- `append` — 在最后一条 system 之后插入
- `merge` — 注入内容与原全部 system 按序合并为一条置顶
- `off` — 原样返回（`if (!systemPrompt || hijackMode === 'off') return messages`）

## 路由拓扑
Profile 前缀路由**先注册**以取得优先级，并以保留词表 `['chat','responses','messages','beta']` 做 `next()` 穿透：
- `POST /v1/:profile/chat/completions`
- `POST /v1/:profile/responses`
- `POST /v1/:profile/messages`

标准路由：
- `POST /v1/chat/completions`（OpenAI Chat）
- `POST /v1/responses`（OpenAI Responses，Codex CLI 用）
- `POST /v1/messages`（Anthropic Messages，Claude Code 用）
- `POST /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/`（Gemini）

**不对称：Gemini 无 profile 前缀路由**，只能用 header 或 model 前缀选 Profile。
**不对称：Claude Code 自行拼接 `/v1/messages`**，无法插入 profile 路径段，实践上只能用 model 前缀（`nova/claude-sonnet-4`）。

所有入口统一提取为 messages 数组（`extractFromResponsesInput` / `extractFromAnthropicBody` / `extractFromGeminiBody`），劫持后按 upstreamType 重建请求体（`buildUpstreamChatBody` / `...AnthropicBody` / `...GeminiBody`），即四协议全矩阵转换。

## Profile 机制
文件形态 `profiles/{name}.json`，字段 `name / displayName / systemPrompt / hijackMode / modelOverride / description`。name 经 `[^a-z0-9_-]` 清洗 + `isValidProfileName` 防路径穿越（1-64 字符）。读写三路径（`listProfiles` / `readProfile` / `saveProfile`）全部过 `normalizeProfile`。

选择优先级（`resolveProfileForRequest`）：
`req.bridgeProfile`（URL 路径）→ `X-Bridge-Profile` header → model 名 `/` 前缀（命中则剥离，真实 model 存入 `_extractedModel`）→ `runtimeConfig.defaultProfile` → null（回落全局）

Admin REST API（端口 6006）：`/admin_api/bridge-profiles`（GET）、`/:name`（GET/POST/DELETE）、`/:name/activate`（POST）、`/deactivate`（POST）。

## System Prompt 文件解析（resolveSystemPrompt）
仅当匹配 `/^[^\\/:*?"<>|\r\n]+\.txt$/i` 才视为文件名，搜索序：插件根目录 → `presets/` 子目录。
**时效不对称**：全局 prompt 在配置加载/热载时解析一次（`:77`）；Profile prompt 每请求同步读盘（`:889`）。故改 Profile 的 txt 立即生效，改全局的 txt 需触发 `bridge-config.json` 热载。

## 与 protocolBridge 的分工
| | VCPBridgeServer | protocolBridge |
|---|---|---|
| 端口 | 独立 3100 | 主服务端口 |
| 走 VCP 链路 | 直接转发上游 | 完整插件/RAG/角色分割 |
| Prompt 劫持 | 五档 | 无 |
| 多 Profile | 请求级切换 | 无 |

**串联形态（默认配置即是）**：CLI → :3100 劫持 → :6015 VCP 主服务全链路 → 真上游。upstreamUrl 留空即自动成立，无需配置。

## 已知缺陷（v2.0.0，实证）
1. **`defaultProfile` 字段在 runtimeConfig 重建时被漏拷**（`bridgeserver.js:73-84` 逐字段拷贝 11 项未含它），而 `resolveProfileForRequest` 读它 → 永远 undefined。表现为面板「设为默认 Profile」成功落盘但请求永不使用。其余三种选法正常。修法：补 `defaultProfile: normalized.defaultProfile,` 或改用对象展开。
2. **`:890` 的 `profileConfig.hijackMode || runtimeConfig.hijackMode` 是死代码**。`normalizeProfile` 恒返回五档之一（未知归 `'off'`），`'off'` 为真值故右侧永不求值。叠加 AdminPanel 新建弹窗显式写入 `hijackMode:"off"`，导致「新建 Profile → 填 systemPrompt → 保存」这一最自然操作静默不生效（`:641` 原样返回，且 `:888` 已进 profile 分支不回落全局）。规避：Profile JSON 中永远显式写非 off 的 hijackMode。
3. **无鉴权 + 全网卡绑定**。`app.listen(port)` 未传 host（实测绑 `::`，但启动日志打印 `127.0.0.1`）；装配段无鉴权中间件；`authorization` 仅作上游 key 兜底（`runtimeConfig.upstreamKey || requestToken`）而 upstreamKey 默认回落主服务 Key。合成风险：同网段无凭证即可白用全链路与上游额度。最小处置 `app.listen(port, '127.0.0.1')`，但与跨机使用需求冲突。
4. 文档层：README 端口 6003（应为 3100）；`plugin-manifest.json` 的 `BRIDGE_HIJACK_MODE` 描述漏列 `merge`（白名单实为五档）。

## 信源
`Plugin/VCPBridgeServer/` 全部源码直读 + `/health` 与 netstat 实测（2026-09-04）。未验证：`resolveSystemPrompt` 文件未命中时的返回分支；鉴权结论限于已读的 app 装配窗口。
