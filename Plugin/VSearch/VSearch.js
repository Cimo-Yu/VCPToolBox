const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { tavily } = require('@tavily/core');

// --- 1. 初始化与配置加载 ---
const configPath = path.resolve(__dirname, './config.env');
// 根配置路径允许用 VSEARCH_ROOT_CONFIG 覆盖：测试需要拿一个空配置隔离本机真实凭据，
// 否则"什么都没配"这类断言会被根目录里已有的 TavilyKey 带跑。生产环境不设此变量。
const rootConfigPath = process.env.VSEARCH_ROOT_CONFIG
    ? path.resolve(process.env.VSEARCH_ROOT_CONFIG)
    : path.resolve(__dirname, '../../config.env');
const manifestPath = path.resolve(__dirname, './plugin-manifest.json');

dotenv.config({ path: configPath });

const {
    VSearchKey: API_KEY,
    VSearchUrl: API_URL,
    VSearchModel: MODEL,
    GrokModel: GROK_MODEL,
    TavilyModel: TAVILY_MODEL,
    SummaryKey: SUMMARY_KEY,
    SummaryUrl: SUMMARY_URL,
    SummaryModel: SUMMARY_MODEL,
    VSearchMaxToken: MAX_TOKENS,
    MaxConcurrent: MAX_CONCURRENT,
    KimiSearchUrl: KIMI_SEARCH_URL,
    KimiSearchKey: KIMI_SEARCH_KEY,
    KimiSearchMaxResults: KIMI_SEARCH_MAX_RESULTS,
    KimiSearchIncludeContent: KIMI_SEARCH_INCLUDE_CONTENT,
} = process.env;

// 代理只服务 grounding 模式里 Vertex 重定向 URL 的解析（见 resolveRedirect），
// 其余请求全部 proxy:false。插件自己的 config.env.example 第 5 节写的是 HTTP_PROXY，
// 而根 config.env 用的是 HTTPS_PROXY，两边从未对齐，于是这个功能一直是死的。
const resolveProxy = (env = {}) => env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy || undefined;
const PROXY = resolveProxy(process.env);

const CONCURRENCY = parseInt(MAX_CONCURRENT, 10) || 5;
const TOKENS = parseInt(MAX_TOKENS, 10) || 50000;
const KIMI_MAX_RESULTS = Math.min(Math.max(parseInt(KIMI_SEARCH_MAX_RESULTS, 10) || 5, 1), 20);
const KIMI_INCLUDE_CONTENT = KIMI_SEARCH_INCLUDE_CONTENT === 'true';
const DEFAULT_PLUGIN_TIMEOUT_MS = 300000;
const MIN_SAFE_REPLY_MARGIN_MS = 5000;
const MAX_SAFE_REPLY_MARGIN_MS = 15000;
const GROK_MAX_RETRIES = 3;
const GROK_BASE_RETRY_DELAY_MS = 1200;

// --- 1.5 后端可用性与模式选择 ---
// 出厂默认是 kimisearch（config.env.example:11），但 Plugin/VSearch/config.env 从没被创建过，
// 14 个 configSchema 键里只有 TavilyKey 恰好因为 TavilySearch 插件而配上了。结果默认模式每次
// 都秒败在"需要配置 KimiSearchKey"，而 grounding/grok 缺 VSearchUrl/VSearchKey 会产出一整篇
// [搜索失败]。默认值必须落在真的能跑的后端上。
const MODE_PRIORITY = ['kimisearch', 'tavily', 'grounding', 'grok'];

const MODE_REQUIREMENTS = {
    kimisearch: 'KimiSearchKey + KimiSearchUrl',
    tavily: 'TavilyKey',
    grounding: 'VSearchKey + VSearchUrl + VSearchModel',
    grok: 'VSearchKey + VSearchUrl',
};

const describeAvailability = ({ kimiKey, kimiUrl, tavilyKey, apiKey, apiUrl, model } = {}) => ({
    kimisearch: Boolean(kimiKey && kimiUrl),
    tavily: Boolean(tavilyKey),
    grounding: Boolean(apiKey && apiUrl && model),
    grok: Boolean(apiKey && apiUrl),
});

const describeMissingConfig = () => MODE_PRIORITY.map(m => `${m} (${MODE_REQUIREMENTS[m]})`).join('、');

// 调用方点名的模式一律照办，缺配置就让它自己报缺配置的错——静默换后端会让
// "我明明指定了 grok" 这类问题彻底无法排查。只在没指定时才挑一个配置齐全的。
const resolveSearchMode = (requested, availability = {}) => {
    const wanted = typeof requested === 'string' ? requested.trim() : '';
    if (wanted) return { mode: wanted, explicit: true };
    const auto = MODE_PRIORITY.find(mode => availability[mode]);
    return { mode: auto || null, explicit: false };
};

// AI 友好型返回：把报告文本包进 content 数组的 type:'text' 元素，规避 JSON 转义地狱
const buildAiFriendlyResult = (reportText) => ({ content: [{ type: 'text', text: reportText }] });

// 全部关键词都失败必须报 error。旧行为是 status:"success" 外加正文里塞 [搜索失败]，
// 于是既进不了 PluginManager 的 ERROR 日志（2026-08-23 代理中断那 6 分钟只看得到
// TavilySearch 在报错，VSearch 一声不响），AI 那头也会当成"确实没搜到"接着往下写。
// 部分失败仍算成功，但在报告开头挂一行提示，让 AI 知道这份报告是不全的。
const buildSearchOutcome = ({ modeLabel, topic, report, okCount, total, firstError }) => {
    if (total > 0 && okCount === 0) {
        return {
            status: 'error',
            error: `VSearch [${modeLabel}] 全部 ${total} 个关键词检索失败：${firstError || '未知错误'}`,
        };
    }
    const notice = (total > 0 && okCount < total)
        ? `> [提示] ${total - okCount}/${total} 个关键词检索失败，以下报告不完整。首个错误: ${firstError || '未知错误'}\n\n`
        : '';
    const reportText = `## VSearch 检索报告 [模式: ${modeLabel}]\n\n**研究主题**: ${topic}\n\n${notice}${report}`;
    return { status: 'success', result: buildAiFriendlyResult(reportText) };
};

// --- 2. 辅助函数 ---
const log = (message) => {
    // 使用 console.error 以免干扰 stdout 的 JSON 输出
    console.error(`[VSearch] ${new Date().toISOString()}: ${message}`);
};

const sendResponse = (data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRemainingMs = (deadline) => Math.max(0, deadline - Date.now());

const getSafeReplyMarginMs = (timeoutMs) => {
    return Math.min(MAX_SAFE_REPLY_MARGIN_MS, Math.max(MIN_SAFE_REPLY_MARGIN_MS, Math.floor(timeoutMs * 0.05)));
};

const loadPluginTimeoutMs = async () => {
    try {
        const manifestContent = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent);
        const timeout = Number(manifest?.communication?.timeout);
        if (Number.isFinite(timeout) && timeout > 0) {
            return timeout;
        }
        log(`manifest 未配置有效 communication.timeout，使用默认 ${DEFAULT_PLUGIN_TIMEOUT_MS}ms`);
    } catch (error) {
        log(`读取 plugin-manifest.json 超时配置失败，使用默认 ${DEFAULT_PLUGIN_TIMEOUT_MS}ms: ${error.message}`);
    }
    return DEFAULT_PLUGIN_TIMEOUT_MS;
};

const createDeadlineContext = async () => {
    const timeoutMs = await loadPluginTimeoutMs();
    const safeMarginMs = getSafeReplyMarginMs(timeoutMs);
    const deadline = Date.now() + Math.max(1000, timeoutMs - safeMarginMs);
    log(`插件硬超时 ${timeoutMs}ms，安全回复余量 ${safeMarginMs}ms，内部截止剩余 ${getRemainingMs(deadline)}ms`);
    return { timeoutMs, safeMarginMs, deadline };
};

const withDeadline = (promise, deadline, onTimeout) => {
    const remaining = getRemainingMs(deadline);
    if (remaining <= 0) {
        return Promise.resolve(onTimeout());
    }
    return Promise.race([
        promise,
        sleep(remaining).then(onTimeout)
    ]);
};

const isGrokRetryableError = (error) => {
    const status = error?.response?.status;
    const message = (error?.message || '').toLowerCase();
    return status === 503 || message.includes('503') || message.includes('empty') || message.includes('空响应');
};

const cleanGrokContent = (content) => content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const resolveRedirect = async (url, signal) => {
    if (!url || !url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
        return url;
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const axiosConfig = {
            maxRedirects: 5,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            responseType: 'text',
            signal
        };

        if (PROXY) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY);
            axiosConfig.proxy = false;
        }

        const response = await axios.get(targetUrl, axiosConfig);

        // 直接取最终 URL，这是 test.js 成功的关键
        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        
        if (finalUrl !== targetUrl && !finalUrl.includes('grounding-api-redirect')) {
            log(`解析成功: ${targetUrl.substring(0, 40)}... -> ${finalUrl}`);
            return finalUrl;
        }

        // 如果 responseUrl 没变，再尝试从 body 里捞一下（作为兜底）
        const body = typeof response.data === 'string' ? response.data : '';
        const metaMatch = body.match(/url=\s*([^"'\s>]+)/i);
        if (metaMatch?.[1]) {
            const resolved = metaMatch[1].replace(/&/g, '&').replace(/["']/g, '');
            if (!resolved.includes('grounding-api-redirect')) {
                return resolved;
            }
        }

        return targetUrl;
    } catch (error) {
        // 报错时也尝试拿一下可能已经跳转的 URL
        const fallbackUrl = error.request?.res?.responseUrl;
        if (fallbackUrl && fallbackUrl !== targetUrl && !fallbackUrl.includes('grounding-api-redirect')) {
            return fallbackUrl;
        }

        log(`解析失败: ${error.message}`);
        return targetUrl;
    }
};

/**
 * Grounding 模式 (Google Search)
 */
const callGroundingMode = async (topic, keyword, showURL = false, deadline, signal) => {
    const now = new Date();
    const currentTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const systemPrompt = `你是一个专业的语义搜索助手。当前系统时间: ${currentTime}。
你的任务是根据用户提供的【检索目标主题】和具体的【检索关键词】，从互联网获取最相关、最准确的信息。

行动指南：
1. 意图对齐：深入理解【检索目标主题】，确保搜索结果能直接服务于该主题的研究。
2. 深度检索：利用内置的 Google Search grounding 工具获取实时信息。
3. 信息精炼：不要简单堆砌搜索结果。请从网页中提取关键事实、核心数据、专家观点或最新进展。
4. 语言风格：专业、客观、精炼。
${showURL ? '5. 严格溯源：每一条重要信息必须附带来源 URL。如果你使用了引用标记（如 [cite: X]），请确保在回复末尾的 [参考来源] 部分列出这些标记对应的完整 URL。' : '5. 节省Token：除非特别重要，否则不需要在正文中列出 URL 链接。'}`;

    const outputRequirements = showURL
        ? '- 包含 [核心发现]、[关键数据/事实] 和 [参考来源] 三部分。'
        : '- 包含 [核心发现] 和 [关键数据/事实] 两部分。';

    const fullSystemPrompt = `${systemPrompt}\n\n输出要求：\n- 针对该关键词，提供一个结构化的总结。\n${outputRequirements}`;

    const userMessage = `【检索目标主题】：${topic}\n【当前检索关键词】：${keyword}`;

    const payload = {
        model: MODEL,
        messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: false,
        max_tokens: TOKENS,
        // NewAPI 的 /v1/chat/completions 兼容层对 Gemini Grounding 的处理更接近
        // OpenAI-compatible tool 外壳：保留原先可识别的 function/googleSearch 声明，
        // 但显式关闭 function_calling_config，避免 tool_choice: "auto" 触发
        // "Function calling config is set without function_declarations."
        tools: [{
            type: "function",
            function: {
                name: "googleSearch",
                description: "从谷歌搜索引擎获取实时信息。",
                parameters: { type: "object", properties: { query: { type: "string" } } }
            }
        }],
        tool_config: {
            function_calling_config: {
                mode: "NONE"
            }
        }
    };

    try {
        const remaining = deadline ? getRemainingMs(deadline) : 180000;
        if (remaining <= 0) {
            return `[搜索超时] 关键词: ${keyword}。已到达插件安全截止时间，跳过该关键词。`;
        }

        log(`[Grounding] 正在搜索关键词: "${keyword}"，剩余安全时间 ${remaining}ms...`);
        const response = await axios.post(API_URL, payload, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: Math.min(180000, remaining),
            signal,
            proxy: false  // 禁用代理，代理仅用于 URL 重定向解析
        });
        let content = response.data.choices[0].message.content;

        // 尝试解析并替换 Vertex 代理 URL
        try {
            const metadata = response.data.choices[0].message?.grounding_metadata || response.data.choices[0]?.grounding_metadata;

            // 1. 提取正文中所有可能的 Vertex 重定向 URL (包括没有协议头的)
            // 修复：[a-zA-Z0-9_=-] 中的 _=- 会被解释为无效范围，改为 [\w\-=]+
            const vertexUrlRegex = /(?:https?:\/\/)?vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[\w\-=]+/g;
            const foundUrls = content.match(vertexUrlRegex) || [];

            // 2. 提取 grounding_metadata 中的 URL
            const metadataUrls = (metadata && metadata.grounding_chunks)
                ? metadata.grounding_chunks.filter(chunk => chunk.web).map(chunk => chunk.web.uri)
                : [];

            // 合并并去重
            const allVertexUrls = [...new Set([...foundUrls, ...metadataUrls])];
            const urlMap = new Map();

            // 并发解析所有发现的 URL
            if (allVertexUrls.length > 0) {
                await Promise.all(allVertexUrls.map(async (vUrl) => {
                    const realUrl = await resolveRedirect(vUrl, signal);
                    if (realUrl !== vUrl) {
                        urlMap.set(vUrl, realUrl);
                    }
                }));

                // 3. 替换正文中的所有匹配项
                for (const [original, resolved] of urlMap.entries()) {
                    content = content.split(original).join(resolved);
                }
            }

            // 4. 构建引证来源列表 (仅在要求 showURL 时使用 metadata)
            if (showURL && metadata && metadata.grounding_chunks) {
                const citations = metadata.grounding_chunks
                    .map((chunk, index) => {
                        if (chunk.web) {
                            const realUrl = urlMap.get(chunk.web.uri) || chunk.web.uri;
                            return `[cite: ${index + 1}] ${chunk.web.title}: ${realUrl}`;
                        }
                        return null;
                    })
                    .filter(c => c !== null);

                if (citations.length > 0) {
                    content += `\n\n**API 自动引证来源 (已解析真实URL):**\n${citations.join('\n')}`;
                }
            }
        } catch (metaError) {
            log(`解析引证元数据/重定向URL时出错: ${metaError.message}`);
        }

        return content;
    } catch (error) {
        const statusCode = error.response?.status || 'N/A';
        let errorDetail = error.message;
        if (error.response?.data) {
            // 兼容流式/对象/字符串等多种响应格式，尽量把 API 返回的真实错误体打出来
            try {
                if (typeof error.response.data === 'string') {
                    errorDetail = error.response.data.substring(0, 1000);
                } else if (Buffer.isBuffer(error.response.data)) {
                    errorDetail = error.response.data.toString('utf8').substring(0, 1000);
                } else {
                    errorDetail = JSON.stringify(error.response.data).substring(0, 1000);
                }
            } catch (e) {
                errorDetail = `${error.message} (响应体序列化失败: ${e.message})`;
            }
        }
        log(`关键词 "${keyword}" 搜索失败 (HTTP ${statusCode}): ${errorDetail}`);
        return `[搜索失败] 关键词: ${keyword}。错误原因: HTTP ${statusCode} - ${errorDetail}`;
    }
};

// --- 3. 主逻辑 ---
/**
 * Grok 模式 (内置搜索，需流式返回)
 */
/**
 * Grok 模式 (内置搜索，单次请求处理所有关键词)
 */
const callGrokOnce = async (topic, keywordList, deadline, attempt) => {
    const systemPrompt = `你是一个具备实时联网搜索能力的顶级 AI 助手。
你的任务是针对用户提供的【检索目标主题】和一系列【检索关键词】，利用你的内置搜索能力获取最新信息并进行深度总结。
请针对每个关键词进行搜索，并最终产出一份结构化、全景式的研究报告。`;

    const userMessage = `【检索目标主题】：${topic}
【检索关键词列表】：
${keywordList.map((kw, i) => `${i + 1}. ${kw}`).join('\n')}

请针对上述关键词执行联网搜索，并结合研究主题给出深度总结。`;

    const payload = {
        model: GROK_MODEL || "grok-4.20-beta",
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: true,
        max_tokens: TOKENS
    };

    const remaining = getRemainingMs(deadline);
    if (remaining <= 0) {
        throw new Error('Grok 请求启动前已到达插件安全截止时间');
    }

    const controller = new AbortController();
    let deadlineTimer = null;

    try {
        log(`[Grok] 第 ${attempt} 次尝试执行全量搜索 (关键词数量: ${keywordList.length})，剩余安全时间 ${remaining}ms...`);
        const response = await axios.post(API_URL, payload, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            responseType: 'stream',
            timeout: remaining,
            signal: controller.signal,
            proxy: false  // 禁用代理，代理仅用于 URL 重定向解析
        });

        return await new Promise((resolve, reject) => {
            let fullContent = '';
            let settled = false;

            const finish = (content, truncated = false) => {
                if (settled) return;
                settled = true;
                if (deadlineTimer) clearTimeout(deadlineTimer);
                try {
                    response.data.destroy();
                } catch (e) { }
                const cleanedContent = cleanGrokContent(content);
                if (truncated) {
                    const suffix = cleanedContent
                        ? '\n\n[提示] 已到达插件安全截止时间，Grok 流式输出已截断，以上为已收到内容。'
                        : '[提示] 已到达插件安全截止时间，但 Grok 尚未返回有效正文。';
                    resolve(`${cleanedContent}${suffix}`);
                    return;
                }
                resolve(cleanedContent);
            };

            const fail = (err) => {
                if (settled) return;
                settled = true;
                if (deadlineTimer) clearTimeout(deadlineTimer);
                reject(err);
            };

            deadlineTimer = setTimeout(() => {
                log(`[Grok] 到达安全截止时间，截断流式输出并返回已收到内容`);
                controller.abort();
                finish(fullContent, true);
            }, Math.max(1, getRemainingMs(deadline)));

            response.data.on('data', chunk => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr === '[DONE]') continue;
                        try {
                            const json = JSON.parse(dataStr);
                            const content = json.choices[0]?.delta?.content || '';
                            fullContent += content;
                        } catch (e) { }
                    }
                }
            });

            response.data.on('end', () => finish(fullContent, false));
            response.data.on('error', err => {
                if (settled && (err.code === 'ERR_CANCELED' || err.message === 'canceled')) return;
                fail(err);
            });
        });
    } catch (error) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        controller.abort();
        throw error;
    }
};

const callGrokMode = async (topic, keywordList, deadline) => {
    let lastError = null;

    for (let attempt = 1; attempt <= GROK_MAX_RETRIES; attempt++) {
        try {
            const result = await callGrokOnce(topic, keywordList, deadline, attempt);
            if (result && result.trim()) {
                return { text: result, failed: false, error: null };
            }

            lastError = new Error('Grok 空响应');
            if (attempt >= GROK_MAX_RETRIES) break;
        } catch (error) {
            lastError = error;
            if (!isGrokRetryableError(error) || attempt >= GROK_MAX_RETRIES) {
                break;
            }
        }

        const delayMs = Math.min(GROK_BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 10000);
        const remaining = getRemainingMs(deadline);
        if (remaining <= delayMs + 1000) {
            log(`[Grok] 剩余安全时间不足以继续退避重试，停止重试`);
            break;
        }

        log(`[Grok] 检测到可重试错误/空响应，${delayMs}ms 后进行第 ${attempt + 1} 次尝试。原因: ${lastError.message}`);
        await sleep(delayMs);
    }

    const message = lastError?.response?.status
        ? `HTTP ${lastError.response.status}: ${lastError.message}`
        : (lastError?.message || '未知错误');
    log(`[Grok] 全量搜索失败: ${message}`);
    // 返回结构体而不是失败字符串：main 要靠 failed 决定 status 是 error 还是 success。
    return { text: `[Grok 搜索失败] 错误原因: ${message}`, failed: true, error: message };
};

/**
 * 从逗号分隔的 key 列表中随机选取一个
 */
const pickRandomKey = (keyStr) => {
    if (!keyStr) return null;
    if (keyStr.includes(',')) {
        const keys = keyStr.split(',').map(k => k.trim()).filter(k => k);
        return keys.length > 0 ? keys[Math.floor(Math.random() * keys.length)] : null;
    }
    return keyStr.trim();
};

/**
 * 直接调用 Tavily SDK 执行单次搜索
 */
const callTavilySearch = async (query, tavilyKeyStr) => {
    const apiKey = pickRandomKey(tavilyKeyStr);
    if (!apiKey) {
        throw new Error('TavilyKey 未配置，请在根目录 config.env 中设置 TavilyKey。');
    }

    const tvly = tavily({ apiKey });
    const response = await tvly.search(query, {
        search_depth: 'advanced',
        topic: 'general',
        max_results: 10,
        include_answer: false,
        include_images: false,
    });

    // 转换为 Markdown 格式
    let markdown = '';
    if (response.results && response.results.length > 0) {
        response.results.forEach((item, index) => {
            markdown += `${index + 1}. **[${item.title}](${item.url})**\n`;
            if (item.content) {
                markdown += `   ${item.content}\n\n`;
            }
        });
    } else {
        markdown = '未找到相关搜索结果。\n';
    }
    return markdown;
};

/**
 * Tavily 模式 (直接调用 Tavily SDK 并发搜索 + 单次整体总结)
 */
const callTavilyMode = async (topic, keywordList, tavilyKeyStr) => {
    // === 阶段1: 并发搜索 ===
    const total = keywordList.length;
    let okCount = 0;
    let firstError = null;
    let combinedResults = '';
    try {
        log(`[Tavily] 阶段1/2: 正在并发获取 ${total} 个关键词的搜索结果 (直接调用 Tavily API)...`);

        const searchPromises = keywordList.map(async (kw) => {
            try {
                const result = await callTavilySearch(kw, tavilyKeyStr);
                log(`[Tavily] 关键词 "${kw}" 搜索成功`);
                return { ok: true, text: `### 关键词: ${kw}\n${result}` };
            } catch (e) {
                log(`[Tavily] 关键词 "${kw}" 搜索失败: ${e.message}`);
                return { ok: false, error: e.message, text: `### 关键词: ${kw}\n[搜索失败]: ${e.message}\n` };
            }
        });

        const allSearchResults = await Promise.all(searchPromises);
        okCount = allSearchResults.filter(r => r.ok).length;
        firstError = allSearchResults.find(r => !r.ok)?.error || null;
        combinedResults = allSearchResults.map(r => r.text).join('\n---\n');
        log(`[Tavily] 阶段1/2 完成: ${okCount}/${total} 个关键词成功，搜索结果总长度 ${combinedResults.length} 字符`);
    } catch (searchError) {
        log(`[Tavily] 阶段1 搜索整体失败: ${searchError.message}`);
        return {
            report: `[Tavily 搜索阶段失败] 错误原因: ${searchError.message}`,
            okCount: 0, total, firstError: searchError.message,
        };
    }

    const done = (report) => ({ report, okCount, total, firstError });

    // 一条都没搜到就别再花一次 LLM 的钱去总结满篇 [搜索失败]，main 会直接报 error。
    if (okCount === 0) {
        return done(combinedResults);
    }

    // === 阶段2: 模型总结 ===
    const summaryKey = SUMMARY_KEY || API_KEY;
    const summaryUrl = SUMMARY_URL || API_URL;
    const summaryModel = SUMMARY_MODEL || TAVILY_MODEL || "claude-sonnet-4-6";

    if (!summaryKey || !summaryUrl) {
        log(`[Tavily] 未配置总结用 LLM API（SummaryKey/SummaryUrl 或 VSearchKey/VSearchUrl），跳过总结阶段，直接返回原始结果`);
        return done(combinedResults);
    }

    try {
        log(`[Tavily] 阶段2/2: 正在使用 ${summaryModel} 通过 ${summaryUrl} 进行全量总结...`);
        const summaryPayload = {
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: `你是一个顶级信息整合专家。你会收到一份关于多个关键词的原始搜索结果汇总。\n你的任务是结合【研究主题：${topic}】，将这些零散的信息提炼成一份高质量、结构化、具有深度洞察的研究报告。\n请保留重要的 URL 链接，并确保报告逻辑严密。`
                },
                { role: 'user', content: `原始搜索结果汇总如下：\n\n${combinedResults}` }
            ],
            max_tokens: TOKENS
        };

        const summaryAxiosConfig = {
            headers: { 'Authorization': `Bearer ${summaryKey}`, 'Content-Type': 'application/json' },
            timeout: 180000,
            proxy: false  // 显式禁用代理，避免环境变量残留干扰
        };

        const summaryResponse = await axios.post(summaryUrl, summaryPayload, summaryAxiosConfig);

        log(`[Tavily] 阶段2/2 完成: 总结成功`);
        return done(summaryResponse.data.choices[0].message.content);
    } catch (summaryError) {
        const statusCode = summaryError.response?.status || 'N/A';
        const errorDetail = summaryError.response?.data ? JSON.stringify(summaryError.response.data).substring(0, 500) : summaryError.message;
        log(`[Tavily] 阶段2 总结失败 (HTTP ${statusCode}): ${errorDetail}`);

        // 总结失败时，回退返回原始搜索结果而不是完全失败
        return done(`[总结阶段失败 (HTTP ${statusCode}): ${summaryError.message}]\n\n**以下为原始搜索结果（未经整合）：**\n\n${combinedResults}`);
    }
};

/**
 * 单次调用 Kimi Search API
 */
const callKimiSearch = async (query, apiKey, baseUrl, maxResults, includeContent) => {
    const url = baseUrl.endsWith('/search') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/search`;
    try {
        log(`[KimiSearch] 正在搜索: "${query}"...`);
        const response = await axios.post(url, {
            text_query: query,
            limit: maxResults,
            enable_page_crawling: includeContent,
            timeout_seconds: 30
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Msh-Tool-Call-Id': `vsearch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            },
            timeout: 180000,
            proxy: false
        });

        const results = response.data.search_results || [];
        if (results.length === 0) {
            return '未找到相关搜索结果。\n';
        }

        let markdown = '';
        results.forEach((item, index) => {
            markdown += `${index + 1}. **${item.title}**\n`;
            markdown += `   URL: ${item.url}\n`;
            if (item.date) markdown += `   Date: ${item.date}\n`;
            if (item.site_name) markdown += `   Source: ${item.site_name}\n`;
            markdown += `   Summary: ${item.snippet}\n`;
            if (item.content) {
                markdown += `\n   ${item.content}\n`;
            }
            markdown += '\n';
        });
        return markdown;
    } catch (error) {
        const status = error.response?.status || 'N/A';
        log(`[KimiSearch] 搜索失败 (HTTP ${status}): ${error.message}`);
        // 抛出而不是返回一句失败文本：调用方要靠这个区分"搜到了"和"没搜到"，
        // 否则失败会被当成正常结果拼进报告，最终整体报 success。
        throw new Error(`HTTP ${status} - ${error.message}`);
    }
};

/**
 * KimiSearch 模式 (并发搜索 + 可选 LLM 总结)
 */
const callKimiSearchMode = async (topic, keywordList, apiKey, baseUrl, maxResults, includeContent) => {
    // === 阶段1: 并发搜索 ===
    const total = keywordList.length;
    let okCount = 0;
    let firstError = null;
    let combinedResults = '';
    try {
        log(`[KimiSearch] 阶段1/2: 正在并发获取 ${total} 个关键词的搜索结果...`);
        const searchPromises = keywordList.map(async (kw) => {
            try {
                const result = await callKimiSearch(kw, apiKey, baseUrl, maxResults, includeContent);
                log(`[KimiSearch] 关键词 "${kw}" 搜索完成`);
                return { ok: true, text: `### 关键词: ${kw}\n${result}` };
            } catch (e) {
                return { ok: false, error: e.message, text: `### 关键词: ${kw}\n[搜索失败] 错误原因: ${e.message}\n` };
            }
        });
        const allSearchResults = await Promise.all(searchPromises);
        okCount = allSearchResults.filter(r => r.ok).length;
        firstError = allSearchResults.find(r => !r.ok)?.error || null;
        combinedResults = allSearchResults.map(r => r.text).join('\n---\n');
        log(`[KimiSearch] 阶段1/2 完成: ${okCount}/${total} 个关键词成功，搜索结果总长度 ${combinedResults.length} 字符`);
    } catch (searchError) {
        log(`[KimiSearch] 阶段1 搜索整体失败: ${searchError.message}`);
        return {
            report: `[KimiSearch 搜索阶段失败] 错误原因: ${searchError.message}`,
            okCount: 0, total, firstError: searchError.message,
        };
    }

    const done = (report) => ({ report, okCount, total, firstError });

    // 一条都没搜到就别再花一次 LLM 的钱去总结满篇 [搜索失败]，main 会直接报 error。
    if (okCount === 0) {
        return done(combinedResults);
    }

    // === 阶段2: 模型总结 (如果配置了 LLM API) ===
    const summaryKey = SUMMARY_KEY || API_KEY;
    const summaryUrl = SUMMARY_URL || API_URL;
    const summaryModel = SUMMARY_MODEL || MODEL || "claude-sonnet-4-6";

    if (!summaryKey || !summaryUrl) {
        log(`[KimiSearch] 未配置总结用 LLM API（SummaryKey/SummaryUrl 或 VSearchKey/VSearchUrl），跳过总结阶段，直接返回原始结果`);
        return done(combinedResults);
    }

    try {
        log(`[KimiSearch] 阶段2/2: 正在使用 ${summaryModel} 通过 ${summaryUrl} 进行全量总结...`);
        const summaryPayload = {
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: `你是一个顶级信息整合专家。你会收到一份关于多个关键词的原始搜索结果汇总。\n你的任务是结合【研究主题：${topic}】，将这些零散的信息提炼成一份高质量、结构化、具有深度洞察的研究报告。\n请保留重要的 URL 链接，并确保报告逻辑严密。`
                },
                { role: 'user', content: `原始搜索结果汇总如下：\n\n${combinedResults}` }
            ],
            max_tokens: TOKENS
        };

        const summaryResponse = await axios.post(summaryUrl, summaryPayload, {
            headers: { 'Authorization': `Bearer ${summaryKey}`, 'Content-Type': 'application/json' },
            timeout: 300000,
            proxy: false
        });

        log(`[KimiSearch] 阶段2/2 完成: 总结成功`);
        return done(summaryResponse.data.choices[0].message.content);
    } catch (summaryError) {
        const statusCode = summaryError.response?.status || 'N/A';
        const errorDetail = summaryError.response?.data ? JSON.stringify(summaryError.response.data).substring(0, 500) : summaryError.message;
        log(`[KimiSearch] 阶段2 总结失败 (HTTP ${statusCode}): ${errorDetail}`);
        return done(`[总结阶段失败 (HTTP ${statusCode}): ${summaryError.message}]\n\n**以下为原始搜索结果（未经整合）：**\n\n${combinedResults}`);
    }
};

// TavilyKey 的取值顺序：先读根目录 config.env（插件 example 第 42 行明说"插件会优先读取
// 根目录配置"），读不到再退回子进程 env（VCP 会按 configSchema 注入，两者通常同值）。
const readTavilyKey = async () => {
    try {
        const rootEnvContent = await fs.readFile(rootConfigPath, 'utf8');
        return dotenv.parse(rootEnvContent).TavilyKey || process.env.TavilyKey || '';
    } catch (e) {
        log(`读取根目录配置失败: ${e.message}`);
        return process.env.TavilyKey || '';
    }
};

async function main(request) {
    const { SearchTopic, Keywords, ShowURL, SearchMode } = request;
    const showURL = ShowURL === true || ShowURL === 'true';

    if (!SearchTopic || !Keywords) {
        return sendResponse({ status: "error", error: "缺少必需参数: SearchTopic 和 Keywords。" });
    }

    const keywordList = Keywords.split(/[,\n，]/).map(k => k.trim()).filter(k => k.length > 0);
    if (keywordList.length === 0) {
        return sendResponse({ status: "error", error: "未识别到有效的关键词。" });
    }

    const tavilyKeyStr = await readTavilyKey();
    const availability = describeAvailability({
        kimiKey: KIMI_SEARCH_KEY, kimiUrl: KIMI_SEARCH_URL,
        tavilyKey: tavilyKeyStr,
        apiKey: API_KEY, apiUrl: API_URL, model: MODEL,
    });
    const { mode, explicit } = resolveSearchMode(SearchMode || process.env.SearchMode, availability);

    if (!mode) {
        return sendResponse({
            status: "error",
            error: `VSearch 没有任何可用的检索后端。请在根目录 config.env 中至少配置一组：${describeMissingConfig()}。`,
        });
    }
    if (!MODE_PRIORITY.includes(mode)) {
        return sendResponse({
            status: "error",
            error: `不支持的 SearchMode: "${mode}"。可选值: ${MODE_PRIORITY.join(' / ')}。`,
        });
    }
    if (explicit && !availability[mode]) {
        log(`调用方显式指定 ${mode} 模式，但其所需配置（${MODE_REQUIREMENTS[mode]}）不完整，按指定模式继续并如实报错`);
    } else if (!explicit) {
        log(`未指定 SearchMode，自动选用已配置的后端: ${mode}（可用: ${MODE_PRIORITY.filter(m => availability[m]).join(', ') || '无'}）`);
    }

    const { deadline } = await createDeadlineContext();
    log(`启动 VSearch [模式: ${mode}]。主题: "${SearchTopic}"，关键词数量: ${keywordList.length}`);
    const total = keywordList.length;

    if (mode === 'grok') {
        // Grok 模式：单次请求处理所有关键词，安全截止前截断流式输出，并对 503/空响应做指数退避重试
        if (!API_URL || !API_KEY) {
            return sendResponse({ status: "error", error: `Grok 模式需要在 config.env 中配置 ${MODE_REQUIREMENTS.grok}。` });
        }
        const { text, failed, error } = await callGrokMode(SearchTopic, keywordList, deadline);
        return sendResponse(buildSearchOutcome({
            modeLabel: 'Grok', topic: SearchTopic, report: text,
            okCount: failed ? 0 : total, total, firstError: error,
        }));
    }

    if (mode === 'tavily') {
        // Tavily 模式：直接调用 Tavily SDK 并发搜索 + 单次总结
        if (!tavilyKeyStr) {
            return sendResponse({ status: "error", error: "Tavily 模式需要在根目录 config.env 中配置 TavilyKey。" });
        }
        const outcome = await callTavilyMode(SearchTopic, keywordList, tavilyKeyStr);
        return sendResponse(buildSearchOutcome({ modeLabel: 'Tavily', topic: SearchTopic, ...outcome }));
    }

    if (mode === 'kimisearch') {
        // KimiSearch 模式：调用 Kimi Search API
        if (!KIMI_SEARCH_KEY) {
            return sendResponse({ status: "error", error: "KimiSearch 模式需要在 config.env 中配置 KimiSearchKey。" });
        }
        if (!KIMI_SEARCH_URL) {
            return sendResponse({ status: "error", error: "KimiSearch 模式需要在 config.env 中配置 KimiSearchUrl。" });
        }
        const outcome = await callKimiSearchMode(SearchTopic, keywordList, KIMI_SEARCH_KEY, KIMI_SEARCH_URL, KIMI_MAX_RESULTS, KIMI_INCLUDE_CONTENT);
        return sendResponse(buildSearchOutcome({ modeLabel: 'KimiSearch', topic: SearchTopic, ...outcome }));
    }

    // Grounding 模式：并发分批执行；到达安全截止时间时，抛弃未返回搜索，直接返回已完成结果
    if (!API_URL || !API_KEY || !MODEL) {
        return sendResponse({ status: "error", error: `Grounding 模式需要在 config.env 中配置 ${MODE_REQUIREMENTS.grounding}。` });
    }
    let allResults = [];
    let okCount = 0;
    let firstError = null;
    let timedOut = false;
    for (let i = 0; i < keywordList.length; i += CONCURRENCY) {
        if (getRemainingMs(deadline) <= 0) {
            timedOut = true;
            log(`[Grounding] 到达安全截止时间，停止启动后续批次`);
            break;
        }

        const chunk = keywordList.slice(i, i + CONCURRENCY);
        const settledResults = [];
        const controllers = chunk.map(() => new AbortController());

        const promises = chunk.map((kw, idx) => callGroundingMode(SearchTopic, kw, showURL, deadline, controllers[idx].signal)
            .then(result => {
                // callGroundingMode 失败时不抛异常，而是返回一段以 [搜索失败] 开头的文本，
                // 所以这里只能靠前缀判断成败——这是它和 tavily/kimi 分支的形状差异。
                const failed = typeof result === 'string' && result.startsWith('[搜索失败]');
                settledResults[idx] = { keyword: kw, result, ok: !failed };
                if (failed && !firstError) firstError = result;
            })
            .catch(error => {
                settledResults[idx] = { keyword: kw, result: `[搜索失败] 关键词: ${kw}。错误原因: ${error.message}`, ok: false };
                if (!firstError) firstError = error.message;
            }));

        await withDeadline(
            Promise.allSettled(promises),
            deadline,
            () => {
                timedOut = true;
                controllers.forEach(controller => controller.abort());
                log(`[Grounding] 当前批次到达安全截止时间，抛弃未完成搜索并返回已完成结果`);
                return null;
            }
        );

        settledResults.forEach(item => {
            if (item) {
                if (item.ok) okCount += 1;
                allResults.push(`### 关键词: ${item.keyword}\n${item.result}\n\n---\n\n`);
            }
        });

        if (timedOut) break;
    }

    const timeoutNotice = timedOut
        ? `> [提示] 已到达插件安全截止时间，未完成的 Grounding 搜索已被抛弃；以下为截止前已完成的结果。\n\n`
        : '';
    const groundingReport = `${timeoutNotice}${allResults.join('') || '[提示] 安全截止前没有搜索任务完成。'}`;
    // 被安全截止抛弃的关键词既没成功也没失败，不计入分母，否则一次超时会把整次调用误判成
    // 全失败。但若截止前一个都没跑完，那就确实是彻底失败，要如实报 error。
    const completed = allResults.length;
    sendResponse(buildSearchOutcome({
        modeLabel: 'Grounding', topic: SearchTopic, report: groundingReport,
        okCount, total: completed > 0 ? completed : total,
        firstError: firstError || (completed === 0 ? '安全截止前没有任何搜索完成' : null),
    }));
}

// 插件入口 (stdio)。用 require.main 守起来，好让测试能 require 这个文件去直接测
// 纯函数，而不会在 require 时挂上 stdin 监听、也不会走到 process.exit。
if (require.main === module) {
    let inputData = '';
    process.stdin.on('data', chunk => { inputData += chunk; });
    process.stdin.on('end', () => {
        try {
            if (!inputData) {
                throw new Error("未从 stdin 接收到任何数据。");
            }
            const request = JSON.parse(inputData);
            main(request);
        } catch (e) {
            log(`解析输入JSON时出错: ${e.message}`);
            sendResponse({ status: "error", error: "无法解析来自主服务的输入参数。" });
        }
    });
}

module.exports = {
    MODE_PRIORITY,
    MODE_REQUIREMENTS,
    describeAvailability,
    describeMissingConfig,
    resolveSearchMode,
    resolveProxy,
    buildSearchOutcome,
};