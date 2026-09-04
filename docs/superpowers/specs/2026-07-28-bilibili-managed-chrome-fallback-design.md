# BilibiliFetch API 优先与托管 Chrome 回退设计

日期：2026-07-28

## 目标

启用 VCP 托管浏览器运行时，并让 Bilibili 数据获取采用“现有 Python API 优先，managed Chrome 回退”的策略。托管 Chrome 使用独立持久化 Profile，首次由用户手动扫码登录 B站；系统不自动把浏览器 Cookie 导出到 Python 或日志。

## 配置设计

根 `config.env` 启用托管浏览器：

- `VCP_BROWSER_RUNTIME_ENABLED=true`
- 保持有头、可见运行，方便首次扫码登录。
- 加载内置 `VCPChrome` 扩展。
- 使用独立 `Plugin/ChromeBridge/managed-profile`。
- 开启自动调试端口、标签页上限和空闲回收。
- `VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE=false`：托管 Chrome 功能全开，但不向用户日常 Chrome 授予 Cookie、Storage、网络响应体和任意脚本等高权限。
- 保留现有 `BILIBILI_COOKIE` 作为 Python API 主路径的可选登录态。

## 数据流

1. `BilibiliFetch.py` 先调用已有 B站 API，获取元数据、字幕、弹幕、评论、高能进度条、快照、搜索结果和 UP 主投稿。
2. 当 API 请求失败、返回风控/权限错误、关键结果为空，或请求需要真实渲染/浏览器登录态时，进入 managed Chrome 回退。
3. 回退复用 `browserRuntimeManager` 启动的 Chrome 和独立 Profile。
4. 用户首次在 managed Chrome 中手动扫码登录 B站，登录状态持久化在 Profile 中。
5. 回退负责补充渲染后的页面标题、简介、正文和动态内容；必要时可使用 CDP 网络响应或页面脚本。
6. 不自动同步或落盘导出 managed Chrome Cookie。

## 第一阶段范围

- 写入并启用根托管浏览器配置。
- 为 BilibiliFetch 增加明确、可关闭的 managed Chrome fallback。
- API 主路径和当前工具参数、输出格式保持兼容。
- 为 fallback 增加失败原因和诊断信息。
- 更新 BilibiliFetch 文档，说明首次扫码登录和降级行为。
- 添加针对 fallback 判定、输出合并及失败降级的测试。

## 暂不实现

- 自动点赞、投币、收藏、关注或发表评论。
- 视频或音频下载。
- 直播间采集和直播弹幕。
- 多账号 Profile。
- 自动导出 Cookie。
- 大规模批量采集。

## 安全边界

- fallback 只选择通过 managed token 校验的 Chrome，不回退到用户 Chrome。
- 用户 Chrome 高权限保持关闭。
- Cookie 留在独立 Profile，不写入工具结果和普通日志。
- 现有 `BILIBILI_COOKIE` 继续作为敏感配置处理。
- 浏览器访问和 CDP 错误只返回脱敏诊断。

## 验收标准

1. `open_chrome` 能启动带 VCPChrome 扩展的独立浏览器并通过 managed token 连接。
2. 用户登录 B站并重启 managed Chrome 后，登录态仍保留。
3. 正常公开视频仍优先走现有 API，不无故启动浏览器。
4. API 失败或关键内容为空时，可按配置触发 managed Chrome fallback。
5. fallback 失败时保留 API 已获得的数据，并返回明确而不泄密的诊断。
6. 不会选择或关闭用户日常 Chrome。
