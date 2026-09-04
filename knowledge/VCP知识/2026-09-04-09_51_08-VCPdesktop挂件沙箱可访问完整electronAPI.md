[2026-09-04 09:51] - 可可

核心概念：VCPdesktop 桌面窗口的 preload（preloads/desktop.js）虽然 exposeInMainWorld 只暴露 electronPath 与 electronAPI 两项，且内部 catalog 定义了约 200 项 invoke 通道，但真正放行的只有 ALLOWED_KEYS 白名单内的键——名单外的方法会被 createCompatApi 替换成 createIsolationStub，调用时抛出「权限已隔离: 方法名」。因此挂件默认无法访问 VChat 的角色、话题与聊天记录，必须显式放行。

权限闸门机制（preloads/desktop.js 关键行）：
- 第 429 行 const ALLOWED_KEYS = [...]，默认 63 项，范围限于 window / theme / desktop / dock / wallpaper / iconset / loom / metrics / music / searchNotes / handleFileDrop。
- 第 60 行 createIsolationStub(name, kind) 生成抛错桩；第 82 行 createCompatApi(definitions, allowedKeys) 按名单逐键决定放行或替换。
- 第 497-498 行 materializeApi / createCompatApi 消费该名单，最终 exposeRoleApis('desktopAPI', ...)。

放行方法：将所需键名追加进 ALLOWED_KEYS 数组。聊天终端类挂件需要的 7 个键为 getAgents, getAgentConfig, loadAgentAvatar, getAgentTopics, createNewTopicForAgent, getChatHistory, saveChatHistory。修改后必须重建窗口才生效——preload 仅在 BrowserWindow 创建时读盘，热重载无效。

安全影响：放行后桌面上任意挂件脚本（含 AI 现场生成的）均可读取并覆盖写入全部角色的 history.json。属于用户自有环境下的可控取舍，但应作为显式决策而非默认配置。

关键原理：
挂件 script 被 widgetManager.buildSandboxCode 包进 (function(document, window){...})(window.document, window) 的闭包。闭包只代理了 document（指向 Shadow DOM root）并额外注入 vcpAPI / musicAPI，window 是原始 window 直传。因此挂件内能拿到 window.electronAPI 对象本身，但该对象已在 preload 层被 ALLOWED_KEYS 过滤过——沙箱不拦截，拦截发生在 preload。挂件能调用的方法集合等于 ALLOWED_KEYS 的交集，其余为抛错桩。

可用接口（挂件内直接调用，均为 ipcRenderer.invoke 封装）：
- getAgents() / getAgentConfig(agentId) / loadAgentAvatar(folderName)
- getAgentTopics(agentId) / createNewTopicForAgent(agentId, topicName, isBranch, locked)
- getChatHistory(agentId, topicId) / saveChatHistory(agentId, topicId, history)
- getAgentGroups() / getGroupTopics(groupId, searchTerm) / getGroupChatHistory(groupId, topicId)
- sendToVCP(vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall, context)
- loadSettings() / getActiveSystemPrompt() / searchTopicsByContent()
白名单共约 200 项 invoke 通道，覆盖 notes / music / canvas / webdav / iconset 等全部模块。

数据结构：
- 聊天记录路径 AppData/UserData/{agentId}/topics/{topicId}/history.json，为消息数组。
- 用户消息 {role,name,content,timestamp,id,attachments}；AI 消息额外带 agentId, topicId, avatarUrl, itemType, agentName, isGroupMessage, isThinking, finishReason, streamOperationId。
- 角色配置 AppData/Agents/{agentId}/config.json，键含 name, systemPrompt, originalSystemPrompt, model, temperature, contextTokenLimit, maxOutputTokens, topics, customCss, cardCss, chatCss。

两条对外请求通道的差异：
- vcpAPI.post(messages, options)：走 settings.vcpServerUrl + Bearer vcpApiKey 的 OpenAI 兼容接口，非流式。挂件无需知道 URL 与 Key，但绕过了 VChat 客户端侧的 {{占位符}} 替换与流式渲染管线。
- vcpAPI.fetch(endpoint)：走 admin_api + Basic Auth，只到后端服务器，读不到本地 history.json。
- electronAPI.sendToVCP：与主窗口同一条流式通道，可完整复用客户端预处理，但需自行处理流式分片与 messageId。

应用场景：桌面常驻聊天终端、跨对象消息聚合面板、话题看板等，任何需要挂件与 VChat 主体状态一致的场合，应优先用 electronAPI 直读直写而非自建本地记忆。

排障要点：VCP 工具参数中的 Windows 路径若含 \v（如 D:\vcp）会被解析为垂直制表符，导致路径被撕裂、脚本静默失败。一律改用正斜杠 D:/vcp/... 或原始字符串。

关联节点：VCPdesktop 三期模块化架构、widgetManager 脚本沙箱、vcpProxy 凭据双轨制（Basic Auth 与 Bearer Token）。
信源出处：实读 D:/vcp/VCPChat/preloads/desktop.js、Desktopmodules/core/widgetManager.js、Desktopmodules/api/vcpProxy.js 及 AppData 实际数据文件。
