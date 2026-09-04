# VCPBridge — 抖音数据桥接插件

> 让抖音页面里的真实数据（API 级精度）直接流进 VCP 的 Agent 世界：结构化提取、字幕转写、爆款收集、喜欢/收藏、搜索、热榜、画像、投喂。

`VCPBridge` 是 [`ChromeBridge`](../README.md) 体系下的抖音专用浏览器扩展（v1.7.0），
服务端指令全部注册在 `Plugin/ChromeBridge` 的 `plugin-manifest.json`（v2.3.0）。

---

## 📋 当前能力总览（目前做到了什么）

| 能力 | 说明 | 状态 |
|---|---|---|
| 视频/图文全量提取 | 文案、标签、互动统计、作者、BGM、无水印地址 | ✅ 已实测 |
| 字幕 + ASR 转写 | 有自带字幕直接返回；无字幕自动下载视频→抽音频→ASR 转写为全文 | ✅ 已实测（SiliconFlow SenseVoiceSmall，4.5 分钟视频转写成功） |
| 作者主页 / 作品列表 | 昵称、粉丝数、`recent_posts[{content_id, content_type}]`，滚动加载对应 B 站 GetUpVideos | 🟢 已实现 |
| 喜欢 / 收藏列表 | 登录态下按 `?showTab=like/collect` 滚动提取列表项 | 🟢 已实现 |
| 关键词搜索 | 对应 BilibiliSearch，返回 `videos[]` / `users[]` | 🟢 已实现 |
| 推荐流爆款收集 | 滚动推荐流去重，带精确互动统计 + 无水印播放地址 | 🟢 已实现 |
| 热搜榜 | 排名 / 话题 / 热度值 / 链接 | ✅ 已实测（50 条） |
| 评论区 | 评论 API 拦截缓存：总数、热门评论、点赞/回复数、昵称/UID/IP 属地、关键词摘要 | 🟢 已实现 |
| 直播弹幕 | 拦截直播 IM/WebSocket，protobuf 启发式解码 | 🧪 实验性 |
| 受众画像 | 创作者平台（creator.douyin.com / 巨量算数）年龄/性别/地域百分比 | 🧪 实验性 |
| 无水印下载 | 优先从页面/接口取无水印播放地址并触发浏览器下载 | 🟢 已实现 |
| 一键投喂 | 页面数据经 WebSocket 进 VCP 投喂队列，Agent 用 `get_feed` 取走 | ✅ 已实测链路 |
| managed Chrome 自动接入 | 扩展以 managed 身份自动连接服务端（高权限、token 校验、保活闹钟+页面唤醒） | ✅ 已实测 |

---

## 🧱 架构

```mermaid
flowchart LR
    A[Douyin Page Main World] <-- postMessage --> B[Content Script]
    B <-- chrome.runtime --> C[Background Service Worker]
    C <-- WebSocket --> D[VCP ChromeBridge Plugin]
    D --> E[Feed Queue / Agent Tools]
```

### 分层职责

| 层 | 文件 | 职责 |
|---|---|---|
| Main World | `main-world/douyin-downloader.js` | 拦截页面真实 XHR/fetch，缓存 `aweme`/评论/弹幕数据，预热详情接口 |
| Content Script | `content-scripts/douyin.js`、`generic.js` | DOM 提取、识别页面类型、查询主世界缓存、注入 🐺 悬浮球、唤醒后台 SW |
| Background | `background.js` | 维护 WebSocket 长连接、接收服务端命令、转发提取/下载/投喂 |
| 服务端 | `../ChromeBridge.js` | 命令注册与鉴权、投喂队列、ASR 转写（ffmpeg + OpenAI 兼容接口）、内部回退接口 |

---

## 📦 安装与连接

### 方式 A：managed Chrome 自动加载（推荐）

1. 根目录 `config.env` 已配置：
   - `VCP_BROWSER_EXTENSION_DIR=Plugin/ChromeBridge/VCPBridge-Extension`
   - `VCP_BROWSER_LOAD_VCPCHROME=true`
2. 服务端启动后自动拉起 managed Chrome 并加载本扩展，扩展读取 `managed-runtime-config.json`，
   以 `clientKind=managed` + 有效 token 连接（`permission=high`）。
3. 扩展带保活闹钟与页面唤醒，浏览器重启后会自动重连。

> 注意：不要对命令行加载的扩展执行 `chrome.runtime.reload()`，可能触发 Chrome
> `DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION` 禁用（重启浏览器即恢复）。

### 方式 B：用户浏览器手动安装

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择本目录。
2. 打开扩展弹窗，填写 `VCP 服务器地址`（如 `localhost:6015`）与 `VCP_Key`。
3. 连接成功后以 `clientKind=user` 接入（抖音数据指令已放行）。

---

## ⚙️ 配置说明

### 服务端 `Plugin/ChromeBridge/config.env`

```env
# ===== 抖音字幕 ASR（douyin_captions 视频无自带字幕时自动转写）=====
DOUYIN_ASR_ENABLED=true
DOUYIN_ASR_BASE_URL=https://api.siliconflow.cn/v1
DOUYIN_ASR_API_KEY=你的Key
DOUYIN_ASR_MODEL=FunAudioLLM/SenseVoiceSmall
DOUYIN_ASR_TIMEOUT_MS=300000
```

流程：下载无水印视频（临时目录 `vcp-douyin-asr-*`）→ ffmpeg 抽 16k 单声道 wav →
调 OpenAI 兼容 `/audio/transcriptions` → 返回 `full_text`（+可选的带时间戳 `segments`）。
**转写完成或失败后，视频与音频临时文件自动删除，不占磁盘。**

### ASR 服务商对照

| 服务商 | `DOUYIN_ASR_BASE_URL` | `DOUYIN_ASR_MODEL` | 说明 |
|---|---|---|---|
| SiliconFlow | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | 国内直连，免费额度，**只返回整段文本**（无时间戳） |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | 返回分段时间戳 |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | 免费且带分段 |

其余服务端配置项：`DebugMode`、`VCP_BROWSER_*`（managed Chrome 行为）见根 `config.env`。

---

## 🎮 指令手册

所有指令通过 VCP 的 TOOL_REQUEST 调用，`tool_name` 均为「ChromeBridge」。

### 1. extract_data（核心：抖音数据提取）

`extract_type` 一览：

| extract_type | 说明 | 返回核心字段 |
|---|---|---|
| `douyin_full` | 当前页面完整数据（自动识别视频/图文/搜索/热搜/直播/作者主页） | video/note + comments + apiEnrichedData |
| `douyin_video` | 视频详情页 | desc, tags, likes, author, bgm, no_watermark_url |
| `douyin_captions` | 视频字幕：优先自带字幕；无自带字幕时触发服务端 ASR 转写 | status / captions[] / full_text / play_url |
| `douyin_author` | 作者主页 | nickname, follower_count, recent_posts[{content_id, content_type}] |
| `douyin_posts` | 作者作品列表（滚动加载，对应 GetUpVideos） | items[{title, views, url, content_id, content_type}] |
| `douyin_likes` | 当前账号“喜欢”列表（url 带 `?showTab=like`） | items[{title, views, url, content_id, content_type}] |
| `douyin_collects` | 当前账号“收藏”列表（url 带 `?showTab=collect`） | items[{title, views, url, content_id, content_type}] |
| `douyin_search` | 关键词搜索（对应 BilibiliSearch） | keyword + videos[] + users[] |
| `douyin_feed` | 推荐流爆款收集（滚动去重） | items[{content_id, desc, author, statistics, play_url}] |
| `douyin_hot` | 热搜榜 | items[{rank, title, hot_value, url}] |
| `douyin_live_danmaku` | 直播弹幕（实验性） | messages[{room_id, nickname, content, create_time}] |
| `douyin_audience_portrait` | 受众画像（需创作者平台登录+数据页） | portraits[{pathname, portraits[{label, data[]}]}] |
| `douyin_note` | 图文笔记 | title, tags, likes, author, images[{src, alt}] |
| `douyin_comments` | 评论区 | comments[{user, content, likes}] |
| `generic` | 通用 DOM 提取 | 页面结构化内容 |

公共参数：`url`（目标地址，不填则提取当前标签页）、`comment_count`（默认 50）、
`include_replies`（默认 true）、`sort_by`（默认 likes）、`max_rounds`（posts/feed 滚动轮数，默认 12/8）、
`max_items`（feed 条数，默认 30）、`danmaku_num`（默认 200）、`portrait_count`（默认 10）。

**提取当前页完整数据：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_full「末」
<<<[END_TOOL_REQUEST]>>>
```

**指定视频页提取字幕（无自带字幕自动 ASR 转写）：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_captions「末」,
url: 「始」https://www.douyin.com/video/7345678901234「末」
<<<[END_TOOL_REQUEST]>>>
```

**查看“喜欢”和“收藏”列表（需登录态）：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_likes「末」,
url: 「始」https://www.douyin.com/user/MS4wLjABAAAAxxx?showTab=like「末」
<<<[END_TOOL_REQUEST]>>>
```
收藏同理，`extract_type` 换为 `douyin_collects`，URL 的 `showTab` 换为 `collect`。

**关键词搜索（对应 BilibiliSearch）：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_search「末」,
keyword: 「始」AI编程「末」,
search_type: 「始」video「末」
<<<[END_TOOL_REQUEST]>>>
```
`search_type` 可选 `video` / `user` / `general`（默认 general）。

**作者作品列表（对应 GetUpVideos）：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_posts「末」,
url: 「始」https://www.douyin.com/user/MS4wLjABAAAAxxx「末」,
max_rounds: 「始」12「末」
<<<[END_TOOL_REQUEST]>>>
```

**热搜榜：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_hot「末」,
url: 「始」https://www.douyin.com/hot「末」
<<<[END_TOOL_REQUEST]>>>
```

**推荐流爆款收集：**
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_feed「末」,
url: 「始」https://www.douyin.com/「末」,
max_items: 「始」30「末」
<<<[END_TOOL_REQUEST]>>>
```

### 2. download_video（无水印下载）
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」download_video「末」,
url: 「始」https://www.douyin.com/video/7345678901234「末」
<<<[END_TOOL_REQUEST]>>>
```
不填 `url` 时下载当前活动标签页视频；可选 `filename` 自定义文件名。

### 3. get_feed（收取浏览器投喂）
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」get_feed「末」
<<<[END_TOOL_REQUEST]>>>
```
读取扩展主动投喂（页面悬浮球“📤 投喂VCP”）的数据队列（最多 100 条），读取后清空。

### 4. get_status / browser_status（状态查询）
```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」get_status「末」
<<<[END_TOOL_REQUEST]>>>
```
返回已连接 Chrome 客户端（能力与权限）、投喂队列大小、最大标签页数。

### 5. ChromeBridge 通用指令

| 命令 | 说明 |
|---|---|
| `open_chrome` / `close_chrome` / `keep_chrome_alive` / `close_managed_tabs` | managed Chrome 生命周期管理 |
| `open_url` | 新标签页打开 URL 并返回页面内容（可选 `browserTarget`） |
| `click` / `type` / `scroll` / `wait` | 页面交互（支持 `vcp-button-*`、`vcp-searchbox-*` 等类型分组 ID） |
| `query_html` / `query_js` / `get_page_info` | 页面结构查询 |
| `capture_screenshot` | 页面截图（返回 Markdown + image_url） |
| `execute_script` / `execute_saved_script` | 执行自定义 JS / 服务端 `ChromeScripts` 目录脚本 |
| `list_tabs` / `switch_tab` / `close_tab` | 标签页管理 |
| `cdp_start` / `cdp_stop` / `cdp_network_query` / `cdp_get_response_body` / `cdp_runtime_evaluate` / `cdp_dom_*` / `cdp_storage_*` / `cdp_emulation_*` / `cdp_network_*` | CDP 调试与会话控制 |
| `page_code_search` | 页面源码搜索（light/enhanced） |

完整参数与调用示例见 `plugin-manifest.json` 的 `capabilities.invocationCommands`。

---

## 🔒 内部回退接口（供独立插件复用）

为未来独立 DouyinFetch 插件预留（需 `x-vcp-key` 头）：

| 接口 | 说明 |
|---|---|
| `POST /internal/chrome-bridge/douyin-page` | 在 managed Chrome 打开抖音页面并返回渲染后 Markdown |
| `POST /internal/chrome-bridge/douyin-cookie` | 动态拉取抖音相关域名 Cookie（含 `sessionid` 登录态） |

---

## 🔄 自动巡逻工作流（Auto-Patrol）

Agent 组合现有命令即可实现抖音账号增量巡检：

1. `get_status` 确认连接；
2. `extract_data(douyin_author, url=用户主页)` 拿 `recent_posts[]`；
3. 与记忆中的 `content_id` 集合对比，筛出新增作品；
4. 对每条新作品 `extract_data(douyin_full, url=/video/ID)`（图文用 `/note/ID`）；
5. 更新记忆，`get_feed` 收取投喂。

---

## ❓ FAQ

### 页面上没有 🐺 悬浮球？
确认是抖音页面、扩展已加载、页面已刷新；关键脚本 `content-scripts/douyin.js`。

### 搜索/某些页面提示验证码？
抖音风控，非登录问题，稍后重试或更换关键词即可；喜欢/收藏需登录态。

### ASR 返回的 `segments` 为空？
所用模型（如 SenseVoiceSmall）只返回整段文本，结果在 `full_text`；换 Whisper/Groq 可获得分段时间戳。

### 转写临时文件会残留吗？
不会。视频+音频+临时目录在转写完成或失败后自动删除（`finally` 清理）。

### 下载失败看哪里？
Background SW 控制台、页面控制台、主世界日志，以及服务端 `DebugLog/ServerLog.txt`。

---

## 📝 版本历史

### v2.3.0（2026-08-01）
- ✨ 抖音 ASR 字幕转写全链路打通（ffmpeg 抽音频 + OpenAI 兼容接口，SiliconFlow SenseVoiceSmall 实测 4.5 分钟视频转写成功）
- ✨ 扩展支持 managed 模式：读取 `managed-runtime-config.json`、上报 managed token（高权限）、保活闹钟 + 页面唤醒自动重连
- 🐛 修复 `aweme.caption`（视频文案）被误判为自带字幕导致 ASR 不触发
- 🐛 修复新标签页提取过早导致 `play_url` 为空（缓存轮询重试）
- 🐛 重写热搜榜提取器：排名/标题/热度值/URL 全部正确（实测 50 条）
- 🎛️ ASR 配置项注册进 manifest `configSchema`；ChromeBridge 直接调用超时 60s → 360s
- 🎛️ managed Chrome 扩展加载目录切换为 `VCPBridge-Extension`

### v2.1.0
- ✨ `douyin_note`、`douyin_author` 增强（content_id + content_type）、`get_status`
- ✨ 自动巡逻工作流文档
- 🐛 修复 extract_data/download_video 超时、feed_data 静默丢弃、open_url 竞态

### v1.x
- 评论 API 拦截、投喂包 comments 字段、悬浮球、无水印下载、三层通信桥接

---

## 📄 许可证

与整个 VCP 项目保持一致。
