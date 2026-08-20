# ChromeBridge - Chrome 浏览器桥接器

> 📱 **抖音插件专属文档**：[VCPBridge — 抖音数据桥接插件](VCPBridge-Extension/README.md)
> （能力总览 / 字幕 ASR 转写配置 / 全部指令手册 / 自动巡逻工作流）

## 📋 概述

ChromeBridge 是一个**混合型插件**，结合了 ChromeObserver 和 ChromeControl 的所有功能：

- 🔍 **Service 模式**：作为常驻服务运行，实时监控浏览器页面内容
- 🎮 **Direct 模式**：支持直接调用命令，执行浏览器控制操作
- ⏳ **智能等待**：执行命令后自动等待页面刷新，返回最新内容
- 🔗 **无缝集成**：通过 WebSocket 与浏览器扩展保持长连接

## 🆚 与旧插件的区别

| 特性 | ChromeObserver | ChromeControl | **ChromeBridge** |
|-----|---------------|---------------|-----------------|
| 实时监控 | ✅ | ❌ | ✅ |
| 执行命令 | ❌ | ✅ | ✅ |
| 等待刷新 | N/A | ❌ (Bug) | ✅ |
| 返回页面内容 | 占位符 | ❌ | ✅ 直接返回 |
| 插件类型 | Service | Synchronous | **Hybrid** |

## 🚀 安装与配置

### 1. 启用插件

在管理面板中启用 ChromeBridge 插件。

### 2. 安装浏览器扩展

使用现有的 VCPChrome 浏览器扩展（无需修改）。

### 3. 配置（可选）

在插件配置中可以设置：

```env
# 是否启用调试模式
DebugMode=false
```

## 📖 使用方法

### 作为 Service（实时监控）

在系统提示词中使用占位符：

```
你可以看到用户的Chrome浏览器内容：
{{VCPChromePageInfo}}
```

### 作为 Direct（执行命令）

AI 可以直接调用以下命令：

#### 1. 打开网页

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」open_url「末」,
url: 「始」https://www.baidu.com「末」
<<<[END_TOOL_REQUEST]>>>
```

**返回示例：**
```json
{
  "success": true,
  "message": "成功打开URL: https://www.baidu.com",
  "page_info": "# 百度一下\nURL: https://www.baidu.com\n\n[输入框: 搜索框](vcp-id-1)\n[按钮: 百度一下](vcp-id-2)\n..."
}
```

#### 2. 点击元素

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」click「末」,
target: 「始」登录「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 3. 输入文本

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」type「末」,
target: 「始」搜索框「末」,
text: 「始」VCP工具箱「末」
<<<[END_TOOL_REQUEST]>>>
```

## 🎬 抖音内容获取（平台桥接）

ChromeBridge 集成了 `VCPBridge-Extension`（本目录下的独立浏览器扩展），可在抖音等平台做**结构化数据提取、视频下载与浏览器投喂**。它通过拦截页面真实 API 请求 + DOM 提取，拿到比普通网页抓取精确得多的数据（互动统计、作者、BGM、无水印链接、评论 API 缓存等）。

### 安装 VCPBridge 扩展

1. 打开 `chrome://extensions/`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择目录：`Plugin/ChromeBridge/VCPBridge-Extension`。
3. 点击扩展图标，填写 `VCP 服务器地址`（默认 `localhost:6015`）与 `VCP_Key` 并连接。
4. 连接成功后，抖音页面左下角会出现 `🎁` 悬浮球（可下载视频 / 评论预览 / 一键投喂 VCP）。

### 提取抖音数据（extract_data）

支持的类型：`douyin_full`（默认，视频/图文全量）、`douyin_video`、`douyin_captions`（视频字幕）、`douyin_note`（图文笔记）、`douyin_author`（作者主页）、`douyin_posts`（作者作品列表，对应 GetUpVideos）、`douyin_likes`（喜欢列表）、`douyin_collects`（收藏列表）、`douyin_search`（关键词搜索，对应 BilibiliSearch）、`douyin_feed`（推荐流爆款收集）、`douyin_hot`（热搜榜）、`douyin_live_danmaku`（直播弹幕，实验性）、`douyin_audience_portrait`（受众画像）、`douyin_comments`、`generic`。

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_full「末」,
url: 「始」https://www.douyin.com/video/7345678901234「末」
<<<[END_TOOL_REQUEST]>>>
```

提取作者主页后，返回的每条作品带 `content_id` + `content_type`，可配合记忆做增量巡检；对每条新作品再调 `douyin_full` 即可拿到完整文案、互动数据与评论。

### 查看“喜欢”和“收藏”列表

需要登录态（扩展所在浏览器已登录抖音）。在用户主页 URL 后加 `?showTab=like`（喜欢）或 `?showTab=collect`（收藏），扩展会自动滚动加载并去重，返回列表项（每条含 `title` / `views` / `url` / `content_id` / `content_type`）：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_likes「末」,
url: 「始」https://www.douyin.com/user/MS4wLjABAAAAxxx?showTab=like「末」
<<<[END_TOOL_REQUEST]>>>
```

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_collects「末」,
url: 「始」https://www.douyin.com/user/MS4wLjABAAAAxxx?showTab=collect「末」
<<<[END_TOOL_REQUEST]>>>
```

注意：若返回 `warnings` 提示“不在喜欢/收藏 Tab”或“未提取到列表项”，通常是未登录、列表为空，或页面还在加载。

### 关键词搜索（对应 BilibiliSearch）

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_search「末」,
keyword: 「始」AI编程「末」,
search_type: 「始」video「末」
<<<[END_TOOL_REQUEST]>>>
```

`search_type` 可选 `video` / `user` / `general`（默认综合）。返回 `videos[]`（标题/作者/统计/url/content_id）与 `users[]`（昵称/签名/粉丝数/sec_uid）；若主世界已拦截到搜索 API 响应，还会附带精确的 `statistics` 和播放地址。

### 获取作者作品列表（对应 GetUpVideos）

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_posts「末」,
url: 「始」https://www.douyin.com/user/MS4wLjABAAAAxxx「末」
<<<[END_TOOL_REQUEST]>>>
```

自动滚动加载（默认 12 轮，可用 `max_rounds` 调整），按 `content_id` 去重，返回作品列表，与 B 站 GetUpVideos 语义一致。

### 高级数据（普通浏览器抓取拿不到的）

普通 HTTP 抓取拿不到抖音的登录态/签名数据，而 VCPBridge 扩展搭在真实浏览器会话上，可以直接消费页面真实 API 的 JSON 响应。

**推荐流爆款收集（douyin_feed）**：滚动推荐流并按 `content_id` 去重，每条带文案、精确互动统计（点赞/评论/收藏/分享/播放）、无水印播放地址：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_feed「末」,
max_items: 「始」20「末」
<<<[END_TOOL_REQUEST]>>>
```

**热搜榜（douyin_hot）**：`https://www.douyin.com/hot` 热搜话题结构化（排名/话题/热度值/链接），不传 url 时自动打开：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_hot「末」
<<<[END_TOOL_REQUEST]>>>
```

**直播弹幕（douyin_live_danmaku，实验性）**：主世界拦截直播 IM 长轮询与 WebSocket，返回昵称/内容/时间；由于弹幕是 protobuf 编码，当前为启发式解码，效果视直播页面版本而定：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_live_danmaku「末」,
url: 「始」https://www.douyin.com/live/房间号「末」,
danmaku_num: 「始」200「末」
<<<[END_TOOL_REQUEST]>>>
```

**受众画像（douyin_audience_portrait）**：在扩展浏览器里登录[创作者服务平台](https://creator.douyin.com)（或[巨量算数](https://trendinsight.oceanengine.com)），打开作品分析/粉丝画像等数据页后调用；主世界会自动扫描 API 响应中的年龄/性别/地域/兴趣分布（百分比原样保留）：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_audience_portrait「末」,
url: 「始」https://creator.douyin.com/creator-micro/data/analysis「末」
<<<[END_TOOL_REQUEST]>>>
```

**限制说明**：视频没有“弹幕”体系，B 站式弹幕在抖音的等价物是评论区（`douyin_comments` 已能拿到 API 级精确数据）；粉丝/观众画像需要创作者平台登录态与对应数据页，私密或付费数据看板拿不到；自动化高频采集有触发风控的风险，请控制频率。

### 提取视频字幕（douyin_captions）

抖音视频一般**没有 B 站那种可下载的 CC 字幕轨道**（创作者字幕大多是烧录在画面里的硬字幕）。`douyin_captions` 采用两级策略：

1. **自带字幕**：少数视频带平台字幕，直接从拦截到的 API 数据里返回字幕轨道信息（`captions[]`）。
2. **ASR 转写**：绝大多数视频无自带字幕——扩展拿到无水印视频地址，服务端用 ffmpeg 抽音频，再调用 OpenAI 兼容的转写接口（默认 `whisper-1`），返回带时间戳的字幕（`segments[{start, end, text}]` + `full_text`）。

开启转写需在 `Plugin/ChromeBridge/config.env` 配置：

```env
DOUYIN_ASR_ENABLED=true
DOUYIN_ASR_BASE_URL=https://api.openai.com/v1
DOUYIN_ASR_API_KEY=你的Key
DOUYIN_ASR_MODEL=whisper-1
```

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」extract_data「末」,
extract_type: 「始」douyin_captions「末」,
url: 「始」https://www.douyin.com/video/7345678901234「末」
<<<[END_TOOL_REQUEST]>>>
```

未配置 ASR 时，`douyin_captions` 会返回无水印 `play_url` 并提示可配置转写，方便先用别的方式转。

### 下载视频（download_video）

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」download_video「末」,
url: 「始」https://www.douyin.com/video/7345678901234「末」
<<<[END_TOOL_REQUEST]>>>
```

浏览器端会优先提取无水印播放地址并触发下载（需扩展具备 `downloads` 权限）。

### 读取投喂队列（get_feed）

用户在抖音页面点击“投喂VCP”后，数据进入服务器队列（最多 100 条），AI 调用 `get_feed` 一次性读取并清空：

```
<<<[TOOL_REQUEST]>>>
tool_name: 「始」ChromeBridge「末」,
command: 「始」get_feed「末」
<<<[END_TOOL_REQUEST]>>>
```

每条投喂包含 `extractedData`（DOM 提取）、`apiEnrichedData`（API 级精确数据：统计/作者/话题/BGM）、`comments`（评论 API 缓存）与 `video_id`。

### 内部回退接口（供其它插件复用）

与 BilibiliFetch 的用法对称，ChromeBridge 额外注册了两个内部路由，便于未来做独立抖音 fetch 插件：

- `POST /internal/chrome-bridge/douyin-page`：在 managed Chrome 中打开抖音页面并返回渲染后的 Markdown（需 `x-vcp-key`）。
- `POST /internal/chrome-bridge/douyin-cookie`：从 managed Chrome 动态拉取抖音相关域名的 Cookie（含 `sessionid` 登录态）。

## 🔧 工作原理

```
┌─────────────────────────────────────────────────────────┐
│                    ChromeBridge 插件                      │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ Service 模式  │              │ Direct 模式   │         │
│  │              │              │              │         │
│  │ • 实时监控    │◄────────────►│ • 执行命令    │         │
│  │ • 更新占位符  │   共享连接    │ • 等待刷新    │         │
│  │ • WebSocket  │              │ • 返回结果    │         │
│  └──────────────┘              └──────────────┘         │
│         ▲                             │                  │
│         │                             ▼                  │
│    pageInfoUpdate               command + wait          │
└─────────┼─────────────────────────────┼─────────────────┘
          │                             │
          │    WebSocket 长连接          │
          │                             │
┌─────────┴─────────────────────────────┴─────────────────┐
│              VCPChrome 浏览器扩展                         │
│  • background.js: 管理连接和命令                         │
│  • content_script.js: 抓取页面内容                       │
└─────────────────────────────────────────────────────────┘
```

### 关键优势

1. **常驻连接**：作为 Service 插件，ChromeBridge 始终保持与浏览器的 WebSocket 连接
2. **内部等待**：命令执行后，在插件内部等待页面刷新，不需要临时 WebSocket 连接
3. **无竞态条件**：使用 `pendingCommands` Map 管理等待状态，避免消息丢失
4. **自动清理**：超时后自动清理待处理命令，防止内存泄漏

## ⚠️ 注意事项

1. **替代旧插件**：ChromeBridge 完全替代 ChromeObserver 和 ChromeControl，可以禁用旧插件
2. **浏览器连接**：确保 VCPChrome 扩展已连接（扩展图标显示绿色 "On"）
3. **页面刷新等待**：命令执行可能需要几秒钟等待页面加载完成
4. **超时设置**：默认超时 30 秒，如果页面加载很慢可能超时

## 🐛 故障排除

### 问题：提示"没有连接的Chrome浏览器"

**解决方案：**
1. 检查浏览器扩展是否已安装
2. 点击扩展图标，确认显示 "On"（绿色）
3. 检查 WebSocket 连接是否正常

### 问题：命令执行超时

**解决方案：**
1. 检查网络连接
2. 确认目标元素存在
3. 查看浏览器控制台是否有错误

### 问题：返回的页面内容不完整

**解决方案：**
1. 页面可能还在加载，稍等几秒后再次查看占位符
2. 检查 content_script.js 是否正确注入
3. 某些动态内容可能需要更长时间加载

## 📝 开发日志

- **v2.3.0** (2026-08-01)
  - 🎬 集成平台桥接扩展 `VCPBridge-Extension`：新增 `extract_data` / `download_video` / `get_feed` / `get_status` 命令
  - 🕵️ 支持抖音视频/图文/作者主页/评论区结构化提取，以及无水印视频下载与浏览器投喂队列
  - 🛰️ 新增 `/internal/chrome-bridge/douyin-page` 与 `/internal/chrome-bridge/douyin-cookie` 内部回退接口
  - 🤝 扩展连接时上报 `clientHello` 能力，服务端按能力选择桥接客户端

- **v2.0.0** (2025-11-14)
  - ✨ 创建混合插件，整合 Observer 和 Control 功能
  - 🐛 修复页面刷新后无法获取内容的问题
  - ⚡ 优化等待逻辑，提高响应速度
  - 📚 添加完整文档

## 📄 许可证

与 VCP 项目相同
