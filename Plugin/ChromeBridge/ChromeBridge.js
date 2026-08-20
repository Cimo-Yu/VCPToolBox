// Plugin/ChromeBridge/ChromeBridge.js
// 混合插件：既是Service（常驻监控），又支持Direct调用（执行命令）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');
const pluginManager = require('../../Plugin.js');
const browserRuntimeManager = require('../../modules/browserRuntimeManager.js');

const execFileAsync = promisify(execFile);

let pluginConfig = {};
let debugMode = false;

// 存储连接的Chrome插件客户端
// key: clientId, value: { clientId, ws, clientKind, remoteAddress, connectedAt, lastSeenAt, capabilities, permissionLevel, managedTokenValid, activeTabInfo, maxTabs, lastPageInfo }
const connectedChromes = new Map();

// 存储等待响应的命令
// key: requestId, value: { resolve, reject, timeout, waitForPageInfo }
const pendingCommands = new Map();

// 浏览器端主动投喂的数据队列（来自 VCPBridge-Extension 的 feed_data 消息）
const feedQueue = [];
const FEED_QUEUE_MAX = 100;

// 抖音页面回退路由允许的域名（含 v.douyin.com 短链 / iesdouyin.com 分享域）
const DOUYIN_PAGE_HOST_RE = /(^|\.)(douyin\.com|iesdouyin\.com)$/i;
// 抖音 Cookie 拉取涉及的域名（页面 / 视频流 / 图片 / 接口）
const DOUYIN_COOKIE_DOMAIN_RE = /(^|\.)(douyin\.com|douyinvod\.com|douyinpic\.com|douyinstatic\.com|iesdouyin\.com|zijieapi\.com|bytedance\.com|byteimg\.com|amemv\.com|snssdk\.com)$/i;

const HIGH_PRIVILEGE_COMMANDS = new Set([
    'execute_script',
    'execute_saved_script',
    'capture_screenshot',
    'get_screenshot',
    'screenshot',
    'cdp_network_query',
    'cdp_get_response_body',
    'cdp_clear_network',
    'cdp_runtime_evaluate',
    'cdp_network_set_extra_http_headers',
    'cdp_network_set_user_agent_override',
    'cdp_emulation_set_timezone_override',
    'cdp_emulation_set_locale_override',
    'cdp_emulation_set_device_metrics_override',
    'cdp_storage_get_cookies',
    'cdp_storage_clear_data_for_origin'
]);

const LIFECYCLE_COMMANDS = new Set([
    'open_chrome',
    'close_chrome',
    'browser_status',
    'keep_chrome_alive',
    'close_managed_tabs'
]);

function nowIso() {
    return new Date().toISOString();
}

function normalizeClientKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase();
    if (['managed', 'agent', 'user', 'distributed'].includes(normalized)) return normalized;
    return 'user';
}

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return Boolean(value);
}

function getMaxTabsLimit() {
    const parsed = Number.parseInt(process.env.VCP_BROWSER_MAX_TABS || pluginConfig.VCP_BROWSER_MAX_TABS || '8', 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 8;
}

function getClientPriority() {
    return String(process.env.VCP_BROWSER_CLIENT_PRIORITY || pluginConfig.VCP_BROWSER_CLIENT_PRIORITY || 'managed,agent,user,distributed')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(item => ['managed', 'agent', 'user', 'distributed'].includes(item));
}

function allowUserHighPrivilege() {
    return parseBoolean(process.env.VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE || pluginConfig.VCP_BROWSER_ALLOW_USER_HIGH_PRIVILEGE, false);
}

function isOpen(ws) {
    return ws && ws.readyState === 1;
}

function getConnection(clientIdOrEntry) {
    if (!clientIdOrEntry) return null;
    if (typeof clientIdOrEntry === 'object' && clientIdOrEntry.ws) return clientIdOrEntry;
    return connectedChromes.get(clientIdOrEntry) || null;
}

function initialize(config) {
    pluginConfig = config || {};
    debugMode = pluginConfig.DebugMode || false;

    if (debugMode) {
        console.log('[ChromeBridge] Initializing hybrid plugin...');
    }

    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "Chrome桥接已加载，等待浏览器连接...");
}

// 在 managed Chrome 中打开页面并返回渲染后的 Markdown（供抖音等平台回退使用）
async function openManagedPageForMarkdown(url, label) {
    const client = await selectChromeClient({ browserTarget: 'managed' }, { allowAutoCreate: true });
    const openResult = await executeSingleCommand(client, {
        command: 'open_url',
        url,
        wait_for_page_info: true,
        pageInfoFallbackMs: 6000
    }, true, false);
    let markdown = openResult.page_info || '';

    if (!markdown) {
        const pageResult = await executeSingleCommand(client, { command: 'get_page_info' }, false, false);
        markdown = pageResult?.result?.markdown || '';
    }

    // 抓取完成后关闭本次打开的标签页，避免 managed Chrome 标签页堆积到上限
    const autoCloseAfterFetch = String(
        process.env.VCP_BROWSER_AUTO_CLOSE_AFTER_URLFETCH ?? 'true'
    ).toLowerCase() !== 'false';
    if (autoCloseAfterFetch) {
        try {
            await executeSingleCommand(client, { command: 'close_tab' }, false, false);
        } catch (closeError) {
            console.warn(`[ChromeBridge] ${label} fallback tab close failed (ignored): ${closeError.message}`);
        }
    }

    return { markdown, pageInfoMeta: openResult.page_info_meta || null };
}

function registerRoutes(app, config, projectBasePath) {
    if (debugMode) {
        console.log('[ChromeBridge] Registering routes...');
    }

    app.post('/internal/chrome-bridge/bilibili-page', async (req, res) => {
        const suppliedKey = String(req.get('x-vcp-key') || '');
        const expectedKey = String(process.env.VCP_Key || process.env.VCP_KEY || '');
        if (!expectedKey || suppliedKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const requestedUrl = String(req.body?.url || '').trim();
        let parsedUrl;
        try {
            parsedUrl = new URL(requestedUrl);
        } catch {
            return res.status(400).json({ success: false, error: '无效的 Bilibili URL' });
        }
        if (parsedUrl.protocol !== 'https:' || !/(^|\.)bilibili\.com$/i.test(parsedUrl.hostname)) {
            return res.status(400).json({ success: false, error: 'fallback 只允许访问 bilibili.com HTTPS URL' });
        }

        try {
            const client = await selectChromeClient({ browserTarget: 'managed' }, { allowAutoCreate: true });
            const openResult = await executeSingleCommand(client, {
                command: 'open_url',
                url: parsedUrl.toString(),
                wait_for_page_info: true,
                pageInfoFallbackMs: 6000
            }, true, false);
            let markdown = openResult.page_info || '';

            if (!markdown) {
                const pageResult = await executeSingleCommand(client, { command: 'get_page_info' }, false, false);
                markdown = pageResult?.result?.markdown || '';
            }

            // 抓取完成后关闭本次打开的标签页，避免 managed Chrome 标签页堆积到上限后再次阻断后续回退
            const autoCloseAfterFetch = String(
                process.env.VCP_BROWSER_AUTO_CLOSE_AFTER_URLFETCH ?? 'true'
            ).toLowerCase() !== 'false';
            if (autoCloseAfterFetch) {
                try {
                    await executeSingleCommand(client, { command: 'close_tab' }, false, false);
                } catch (closeError) {
                    console.warn(`[ChromeBridge] Bilibili fallback tab close failed (ignored): ${closeError.message}`);
                }
            }

            return res.json({
                success: true,
                markdown,
                pageInfoMeta: openResult.page_info_meta || null
            });
        } catch (error) {
            console.warn(`[ChromeBridge] Bilibili fallback failed: ${error.message}`);
            return res.status(502).json({
                success: false,
                error: 'managed Chrome 未能获取 Bilibili 页面',
                code: error.code || 'BILIBILI_BROWSER_FALLBACK_FAILED'
            });
        }
    });

    // 动态获取托管 Chrome 中 B 站的登录 Cookie（供 BilibiliFetch 等插件按需取用）
    app.post('/internal/chrome-bridge/bilibili-cookie', async (req, res) => {
        const suppliedKey = String(req.get('x-vcp-key') || '');
        const expectedKey = String(process.env.VCP_Key || process.env.VCP_KEY || '');
        if (!expectedKey || suppliedKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        try {
            await browserRuntimeManager.ensureManagedBrowser();
            const browserWSEndpoint = await browserRuntimeManager.getManagedBrowserWebSocketEndpoint();
            if (!browserWSEndpoint) {
                throw new Error('managed Chrome DevTools WebSocket endpoint unavailable');
            }

            const browser = await puppeteer.connect({ browserWSEndpoint });
            try {
                const pages = await browser.pages();
                if (!pages || pages.length === 0) {
                    throw new Error('managed Chrome 没有可用的页面 target');
                }
                const cdpSession = await pages[0].createCDPSession();
                await cdpSession.send('Network.enable');

                let { cookies } = await cdpSession.send('Network.getAllCookies');

                // 可选引导：托管浏览器无登录态时，用配置中的静态 Cookie 种入浏览器一次，
                // 之后浏览器即成为动态会话来源（BILIBILI_COOKIE_BOOTSTRAP=true 开启）
                const bootstrapEnabled = String(process.env.BILIBILI_COOKIE_BOOTSTRAP || 'false').toLowerCase() === 'true';
                const hasSessionCookie = Array.isArray(cookies) && cookies.some(c => c.name === 'SESSDATA' && c.value);
                if (bootstrapEnabled && !hasSessionCookie) {
                    const staticCookie = String(process.env.BILIBILI_COOKIE || '');
                    const sessionNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']);
                    const pairs = staticCookie.split(';').map(p => p.trim()).filter(Boolean);
                    for (const pair of pairs) {
                        const eq = pair.indexOf('=');
                        if (eq <= 0) continue;
                        const name = pair.slice(0, eq).trim();
                        if (!sessionNames.has(name)) continue;
                        const value = pair.slice(eq + 1);
                        try {
                            await cdpSession.send('Network.setCookie', {
                                name,
                                value,
                                domain: '.bilibili.com',
                                path: '/',
                                secure: true,
                                httpOnly: name === 'SESSDATA',
                                expires: name === 'SESSDATA' ? Math.floor(Date.now() / 1000) + 15552000 : -1
                            });
                        } catch (setError) {
                            console.warn(`[ChromeBridge] Bootstrap cookie set failed (${name}): ${setError.message}`);
                        }
                    }
                    const refreshed = await cdpSession.send('Network.getAllCookies');
                    if (refreshed && Array.isArray(refreshed.cookies)) {
                        cookies = refreshed.cookies;
                    }
                }

                const biliCookieDomains = /(^|\.)(bilibili\.com|bilivideo\.com|hdslb\.com|b23\.tv)$/i;
                const biliCookies = (Array.isArray(cookies) ? cookies : [])
                    .filter(c => c && c.name && c.domain && biliCookieDomains.test(c.domain));

                const cookieString = biliCookies
                    .map(c => `${c.name}=${c.value}`)
                    .join('; ');

                return res.json({
                    success: true,
                    cookie: cookieString,
                    count: biliCookies.length,
                    hasSession: /(^|;\s*)SESSDATA=[^;]/i.test(cookieString)
                });
            } finally {
                try {
                    await browser.disconnect();
                } catch (_) {
                    // ignore
                }
            }
        } catch (error) {
            console.warn(`[ChromeBridge] Bilibili cookie fetch failed: ${error.message}`);
            return res.status(502).json({
                success: false,
                error: 'managed Chrome Cookie 获取失败',
                code: error.code || 'BILIBILI_COOKIE_FETCH_FAILED'
            });
        }
    });

    // 动态获取 managed Chrome 中抖音页面渲染后的 Markdown（供 DouyinFetch 等插件按需回退）
    app.post('/internal/chrome-bridge/douyin-page', async (req, res) => {
        const suppliedKey = String(req.get('x-vcp-key') || '');
        const expectedKey = String(process.env.VCP_Key || process.env.VCP_KEY || '');
        if (!expectedKey || suppliedKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const requestedUrl = String(req.body?.url || '').trim();
        let parsedUrl;
        try {
            parsedUrl = new URL(requestedUrl);
        } catch {
            return res.status(400).json({ success: false, error: '无效的 Douyin URL' });
        }
        if (parsedUrl.protocol !== 'https:' || !DOUYIN_PAGE_HOST_RE.test(parsedUrl.hostname)) {
            return res.status(400).json({ success: false, error: 'fallback 只允许访问 douyin.com HTTPS URL' });
        }

        try {
            const result = await openManagedPageForMarkdown(parsedUrl.toString(), 'Douyin');
            return res.json({ success: true, ...result });
        } catch (error) {
            console.warn(`[ChromeBridge] Douyin fallback failed: ${error.message}`);
            return res.status(502).json({
                success: false,
                error: 'managed Chrome 未能获取 Douyin 页面',
                code: error.code || 'DOUYIN_BROWSER_FALLBACK_FAILED'
            });
        }
    });

    // 动态获取 managed Chrome 中抖音相关域名的 Cookie（供 DouyinFetch 等插件按需取用）
    app.post('/internal/chrome-bridge/douyin-cookie', async (req, res) => {
        const suppliedKey = String(req.get('x-vcp-key') || '');
        const expectedKey = String(process.env.VCP_Key || process.env.VCP_KEY || '');
        if (!expectedKey || suppliedKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        try {
            await browserRuntimeManager.ensureManagedBrowser();
            const browserWSEndpoint = await browserRuntimeManager.getManagedBrowserWebSocketEndpoint();
            if (!browserWSEndpoint) {
                throw new Error('managed Chrome DevTools WebSocket endpoint unavailable');
            }

            const browser = await puppeteer.connect({ browserWSEndpoint });
            try {
                const pages = await browser.pages();
                if (!pages || pages.length === 0) {
                    throw new Error('managed Chrome 没有可用的页面 target');
                }
                const cdpSession = await pages[0].createCDPSession();
                await cdpSession.send('Network.enable');

                const { cookies } = await cdpSession.send('Network.getAllCookies');
                const douyinCookies = (Array.isArray(cookies) ? cookies : [])
                    .filter(c => c && c.name && c.domain && DOUYIN_COOKIE_DOMAIN_RE.test(c.domain));

                const cookieString = douyinCookies
                    .map(c => `${c.name}=${c.value}`)
                    .join('; ');

                return res.json({
                    success: true,
                    cookie: cookieString,
                    count: douyinCookies.length,
                    hasSession: /(^|;\s*)sessionid(_ss)?=[^;]/i.test(cookieString)
                });
            } finally {
                try {
                    await browser.disconnect();
                } catch (_) {
                    // ignore
                }
            }
        } catch (error) {
            console.warn(`[ChromeBridge] Douyin cookie fetch failed: ${error.message}`);
            return res.status(502).json({
                success: false,
                error: 'managed Chrome Cookie 获取失败',
                code: error.code || 'DOUYIN_COOKIE_FETCH_FAILED'
            });
        }
    });
}

function updateClientFromHello(entry, helloData = {}) {
    const declaredKind = normalizeClientKind(helloData.clientKind);
    const tokenValid = declaredKind === 'managed' && browserRuntimeManager.validateManagedToken(helloData.managedToken);

    entry.clientKind = tokenValid ? 'managed' : (declaredKind === 'managed' ? 'user' : declaredKind);
    entry.managedTokenValid = tokenValid;
    entry.permissionLevel = (tokenValid || entry.clientKind === 'agent') ? 'high' : 'restricted';
    entry.capabilities = Array.isArray(helloData.capabilities) ? helloData.capabilities : [];
    entry.extensionVersion = helloData.extensionVersion || entry.extensionVersion || null;
    entry.userAgent = helloData.userAgent || entry.userAgent || null;
    entry.platform = helloData.platform || entry.platform || null;
    entry.maxTabs = Number.parseInt(helloData.maxTabs, 10) || getMaxTabsLimit();
    entry.lastSeenAt = nowIso();

    if (tokenValid) {
        browserRuntimeManager.touchManagedBrowser();
    }

    console.log(`[ChromeBridge] 🤝 clientHello: ${entry.clientId}, kind=${entry.clientKind}, permission=${entry.permissionLevel}, tokenValid=${entry.managedTokenValid}`);
}

// WebSocketServer调用：新Chrome客户端连接
function handleNewClient(ws) {
    const clientId = ws.clientId;
    const remoteAddress = ws.clientIp || ws._socket?.remoteAddress || null;

    const entry = {
        clientId,
        ws,
        clientKind: 'user',
        remoteAddress,
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
        capabilities: [],
        permissionLevel: 'restricted',
        managedTokenValid: false,
        activeTabInfo: null,
        lastPageInfo: null,
        extensionVersion: null,
        userAgent: null,
        platform: null,
        maxTabs: getMaxTabsLimit()
    };

    connectedChromes.set(clientId, entry);

    console.log(`[ChromeBridge] ✅ Chrome客户端已连接: ${clientId}, 总数: ${connectedChromes.size}`);
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器已连接，等待页面信息...");

    ws.on('close', () => {
        connectedChromes.delete(clientId);
        console.log(`[ChromeBridge] ❌ Chrome客户端断开: ${clientId}, 剩余: ${connectedChromes.size}`);

        if (connectedChromes.size === 0) {
            pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器连接已断开。");
        }
    });

    ws.on('error', (error) => {
        console.warn(`[ChromeBridge] Chrome客户端错误 ${clientId}: ${error.message}`);
    });
}

// WebSocketServer调用：收到Chrome客户端的消息
function handleClientMessage(clientId, message) {
    const entry = connectedChromes.get(clientId);
    if (entry) {
        entry.lastSeenAt = nowIso();
        if (entry.clientKind === 'managed') {
            browserRuntimeManager.touchManagedBrowser();
        }
    }

    if (message.type === 'clientHello') {
        if (entry) {
            updateClientFromHello(entry, message.data || {});
        }
        return;
    }

    if (message.type === 'pageInfoUpdate') {
        const data = message.data || {};
        const markdown = data.markdown;

        if (entry) {
            const lines = String(markdown || '').split('\n');
            const title = data.title || (lines[0] || '').replace(/^#\s*/, '').trim();
            const urlLine = lines.find(line => /^URL:\s*/i.test(line));
            const url = data.url || (urlLine ? urlLine.replace(/^URL:\s*/i, '').trim() : '');
            entry.activeTabInfo = {
                title,
                url,
                snapshotId: data.snapshotId,
                elementCount: data.elementCount,
                generatedAt: data.generatedAt,
                updatedAt: nowIso()
            };
            entry.lastPageInfo = {
                markdown,
                snapshotId: data.snapshotId,
                generatedAt: data.generatedAt,
                url,
                title,
                elementCount: data.elementCount,
                elements: Array.isArray(data.elements) ? data.elements : [],
                error: data.error || null,
                updatedAt: nowIso()
            };
        }

        // 更新占位符
        pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", markdown);

        if (debugMode) {
            console.log(`[ChromeBridge] 📄 收到页面更新，长度: ${markdown?.length || 0}`);
        }

        // 检查是否有等待此页面信息的命令
        pendingCommands.forEach((pendingCmd, requestId) => {
            if (pendingCmd.waitForPageInfo && pendingCmd.commandExecuted) {
                console.log(`[ChromeBridge] 🎉 命令 ${requestId} 收到页面信息，准备返回`);
                clearTimeout(pendingCmd.timeout);
                if (pendingCmd.fallbackTimer) {
                    clearTimeout(pendingCmd.fallbackTimer);
                }
                pendingCmd.resolve({
                    success: true,
                    message: pendingCmd.executionMessage,
                    result: pendingCmd.commandResult,
                    page_info: markdown,
                    page_info_meta: entry?.lastPageInfo ? {
                        snapshotId: entry.lastPageInfo.snapshotId,
                        generatedAt: entry.lastPageInfo.generatedAt,
                        url: entry.lastPageInfo.url,
                        title: entry.lastPageInfo.title,
                        elementCount: entry.lastPageInfo.elementCount
                    } : null
                });
                pendingCommands.delete(requestId);
            }
        });
    }

    // 处理平台桥接扩展（VCPBridge-Extension）返回的数据提取结果
    if (message.type === 'extract_result') {
        const data = message.data || {};
        const requestId = data.requestId;
        const pending = requestId && pendingCommands.get(requestId);
        if (!pending) {
            if (debugMode) console.warn(`[ChromeBridge] extract_result 无匹配的 pending 命令: ${requestId}`);
            return;
        }
        clearTimeout(pending.timeout);
        if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
        pendingCommands.delete(requestId);

        if (data.status === 'error') {
            pending.reject(new Error(data.error || '数据提取失败'));
        } else {
            console.log(`[ChromeBridge] 🎉 数据提取完成: ${requestId}, 类型: ${data.extract_type}`);
            pending.resolve({
                success: true,
                extract_type: data.extract_type,
                data: data.extractedData,
                source_url: data.sourceUrl,
                page_type: data.page_type || null,
                extracted_at: new Date().toISOString()
            });
        }
        return;
    }

    // 处理平台桥接扩展返回的视频下载结果
    if (message.type === 'download_result') {
        const data = message.data || {};
        const requestId = data.requestId;
        const pending = requestId && pendingCommands.get(requestId);
        if (!pending) {
            if (debugMode) console.warn(`[ChromeBridge] download_result 无匹配的 pending 命令: ${requestId}`);
            return;
        }
        clearTimeout(pending.timeout);
        if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
        pendingCommands.delete(requestId);

        if (data.status === 'error') {
            pending.reject(new Error(data.error || '视频下载失败'));
        } else {
            console.log(`[ChromeBridge] 🎉 视频下载任务已创建: ${requestId}`);
            pending.resolve({
                success: true,
                message: data.message || '视频下载任务已开始',
                task_id: data.task_id || null,
                file_name: data.file_name || null,
                save_path: data.save_path || null,
                source_url: data.source_url || null,
                created_at: new Date().toISOString()
            });
        }
        return;
    }

    // 处理浏览器扩展主动投喂的数据（用户点击“投喂VCP”等）
    if (message.type === 'feed_data') {
        const data = message.data || {};
        console.log(`[ChromeBridge] 🎁 收到浏览器投喂数据: ${data.extract_type} from ${data.sourceUrl}`);
        const feedData = {
            id: `feed-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            extract_type: data.extract_type,
            page_type: data.page_type || null,
            data: data.extractedData,
            apiEnrichedData: data.apiEnrichedData || null,
            comments: data.comments || null,
            video_id: data.video_id || null,
            feed_warning: data.feed_warning || null,
            source_url: data.sourceUrl || null,
            fed_at: new Date().toISOString()
        };
        feedQueue.push(feedData);
        if (feedQueue.length > FEED_QUEUE_MAX) feedQueue.shift();
        console.log(`[ChromeBridge] 📥 投喂数据已入队，当前队列长度: ${feedQueue.length}`);
        return;
    }
}

function buildCommandFromParams(params, suffix = '') {
    const cmd = {
        command: params[`command${suffix}`],
        browserTarget: params[`browserTarget${suffix}`] || params.browserTarget,
        target: params[`target${suffix}`],
        text: params[`text${suffix}`],
        url: params[`url${suffix}`],
        format: params[`format${suffix}`],
        imageFormat: params[`imageFormat${suffix}`],
        quality: params[`quality${suffix}`],
        urlIncludes: params[`urlIncludes${suffix}`],
        cdpRequestId: params[`requestId${suffix}`] || params[`cdpRequestId${suffix}`],
        query: params[`query${suffix}`],
        scope: params[`scope${suffix}`],
        useRegex: params[`useRegex${suffix}`],
        caseSensitive: params[`caseSensitive${suffix}`],
        contextChars: params[`contextChars${suffix}`],
        maxResults: params[`maxResults${suffix}`],
        scriptName: params[`scriptName${suffix}`],
        direction: params[`direction${suffix}`],
        amount: params[`amount${suffix}`],
        x: params[`x${suffix}`],
        y: params[`y${suffix}`],
        behavior: params[`behavior${suffix}`],
        expression: params[`expression${suffix}`],
        selector: params[`selector${suffix}`],
        nodeId: params[`nodeId${suffix}`],
        depth: params[`depth${suffix}`],
        pierce: params[`pierce${suffix}`],
        headers: params[`headers${suffix}`],
        userAgent: params[`userAgent${suffix}`],
        acceptLanguage: params[`acceptLanguage${suffix}`],
        platform: params[`platform${suffix}`],
        timezoneId: params[`timezoneId${suffix}`],
        locale: params[`locale${suffix}`],
        width: params[`width${suffix}`],
        height: params[`height${suffix}`],
        deviceScaleFactor: params[`deviceScaleFactor${suffix}`],
        mobile: params[`mobile${suffix}`],
        origin: params[`origin${suffix}`],
        storageTypes: params[`storageTypes${suffix}`],
        cdpParams: params[`cdpParams${suffix}`],
        snapshotId: params[`snapshotId${suffix}`],
        strict: params[`strict${suffix}`],
        wait_for_page_info: params[`wait_for_page_info${suffix}`],
        pageInfoFallbackMs: params[`pageInfoFallbackMs${suffix}`],
        waitMs: params[`waitMs${suffix}`],
        durationMs: params[`durationMs${suffix}`],
        seconds: params[`seconds${suffix}`]
    };

    Object.keys(cmd).forEach(key => cmd[key] === undefined && delete cmd[key]);
    return cmd;
}

function authorizeChromeCommand(entry, command) {
    if (!entry) {
        return { allowed: false, reason: '未选择浏览器客户端' };
    }

    if (LIFECYCLE_COMMANDS.has(command)) {
        return { allowed: true };
    }

    if ((entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent') {
        return { allowed: true };
    }

    if (HIGH_PRIVILEGE_COMMANDS.has(command)) {
        if (entry.clientKind === 'user' && allowUserHighPrivilege()) {
            return { allowed: true };
        }
        return {
            allowed: false,
            reason: `高权限指令 ${command} 默认只允许 managed Chrome 执行，当前目标为 ${entry.clientKind}`
        };
    }

    if (entry.clientKind === 'distributed') {
        const distributedAllowed = new Set(['open_url', 'click', 'type', 'scroll', 'query_html', 'query_js', 'get_page_info', 'list_tabs', 'switch_tab']);
        if (!distributedAllowed.has(command)) {
            return {
                allowed: false,
                reason: `distributed Chrome 默认不允许执行 ${command}`
            };
        }
    }

    return { allowed: true };
}

function getOpenClients() {
    return Array.from(connectedChromes.values()).filter(entry => isOpen(entry.ws));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getWaitDurationMs(cmdParams = {}) {
    const rawValue = cmdParams.waitMs ?? cmdParams.durationMs ?? cmdParams.seconds;
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) return 1000;

    const durationMs = rawValue === cmdParams.seconds ? parsed * 1000 : parsed;
    return Math.min(Math.max(Math.round(durationMs), 0), 30000);
}

function isWaitCommand(command) {
    return ['wait', 'sleep', 'delay'].includes(String(command || '').trim().toLowerCase());
}

async function waitForManagedClient(timeoutMs = 10000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const managed = getOpenClients().find(entry =>
            (entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent'
        );
        if (managed) return managed;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return null;
}

function getManagedConnectionDiagnostics() {
    const clients = getOpenClients().map(summarizeClient);
    const rejectedManagedLikeClients = clients.filter(client =>
        client.clientKind === 'user' &&
        client.managedTokenValid === false
    );

    return {
        runtime: browserRuntimeManager.getManagedBrowserStatus(),
        clients,
        rejectedManagedLikeClients,
        hint: 'open_chrome 接受 clientKind=managed 且 managedTokenValid=true 的托管 Chrome，或用户在扩展 Popup 中显式切换的 clientKind=agent 高权限模式；若没有任何 clients，优先怀疑扩展未加载或 MV3 service worker 没有启动。'
    };
}

async function selectChromeClient(cmdParams = {}, options = {}) {
    const target = normalizeClientKind(cmdParams.browserTarget || options.browserTarget || 'managed');
    const allowAutoCreate = options.allowAutoCreate !== false;
    let clients = getOpenClients();

    const isManagedEntry = (entry) =>
        (entry.clientKind === 'managed' && entry.managedTokenValid) || entry.clientKind === 'agent';

    const findByKind = (kind) => clients.find(entry => {
        if (kind === 'managed') return isManagedEntry(entry);
        return entry.clientKind === kind;
    });

    // 通用浏览器控制命令优先选择声明 pageInfo 能力的客户端（VCPChrome 扩展）；
    // 平台提取类命令由 selectPlatformBridgeClient 按 extract_data 能力单独路由（VCPBridge 扩展）。
    // 只有一个客户端时行为与原来完全一致。
    const hasGeneralControlCapability = (entry) =>
        Array.isArray(entry.capabilities) && entry.capabilities.includes('pageInfo');

    if (target === 'managed') {
        let managed = clients.find(entry => isManagedEntry(entry) && hasGeneralControlCapability(entry));
        if (!managed) managed = findByKind('managed');
        if (!managed && allowAutoCreate) {
            await browserRuntimeManager.ensureManagedBrowser();
            managed = await waitForManagedClient();
        }
        if (!managed) {
            const diagnostics = getManagedConnectionDiagnostics();
            throw new Error(JSON.stringify({
                plugin_error: '未找到已通过 token 校验的 managed Chrome。不会回退到用户 Chrome。',
                diagnostics
            }));
        }
        return managed;
    }

    if (cmdParams.browserTarget) {
        return findByKind(target);
    }

    for (const kind of getClientPriority()) {
        const selected = findByKind(kind);
        if (selected) return selected;
    }

    if (allowAutoCreate) {
        await browserRuntimeManager.ensureManagedBrowser();
        return waitForManagedClient();
    }

    return null;
}

async function enforceManagedTabLimit(entry, cmdParams) {
    if (!entry || entry.clientKind !== 'managed' || cmdParams.command !== 'open_url') return;

    const maxTabs = getMaxTabsLimit();
    const tabsResult = await executeSingleCommand(entry, { command: 'list_tabs' }, false, false, { skipAuthorization: true, skipTouch: true });
    const result = tabsResult?.result;
    const count = Array.isArray(result) ? result.length : Number(result?.count || result?.tabs?.length || 0);

    if (count >= maxTabs) {
        throw new Error(`managed Chrome 当前标签页 ${count}/${maxTabs}，已拒绝继续打开新标签页以保护服务器 RAM。可先调用 close_tab/close_managed_tabs 清理。`);
    }
}

// 执行单个命令的辅助函数（内部使用）
async function executeSingleCommand(chromeEntryOrWs, cmdParams, waitForPageInfo = false, isInCommandChain = false, options = {}) {
    const entry = getConnection(chromeEntryOrWs) || (chromeEntryOrWs?.send ? { ws: chromeEntryOrWs, clientKind: 'user', permissionLevel: 'restricted' } : null);
    if (!entry || !isOpen(entry.ws)) {
        throw new Error('目标 Chrome 客户端不可用或已断开');
    }

    const { command } = cmdParams;
    if (!options.skipAuthorization) {
        const auth = authorizeChromeCommand(entry, command);
        if (!auth.allowed) {
            throw new Error(auth.reason);
        }
    }

    if (!options.skipTouch && entry.clientKind === 'managed') {
        browserRuntimeManager.touchManagedBrowser();
    }

    const bridgeRequestId = `cb-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // 只有会导致页面导航/交互变化的命令才默认等待页面信息；CDP/查询/脚本执行类指令直接返回结构化结果
    const pageChangingCommands = new Set(['open_url', 'click', 'type', 'scroll']);
    const needsPageLoad = (command === 'open_url' && isInCommandChain);
    const actualWaitForPageInfo = (waitForPageInfo && pageChangingCommands.has(command)) || needsPageLoad || cmdParams.wait_for_page_info === true;

    console.log(`[ChromeBridge] 🚀 执行命令: ${command}, target=${entry.clientKind}, requestId: ${bridgeRequestId}, 等待页面加载: ${actualWaitForPageInfo}`);

    // 构建命令消息，透传所有参数，但内部回调 requestId 必须最后写入，避免被 CDP 的网络 requestId 覆盖
    const commandMessage = {
        type: 'command',
        data: {
            ...cmdParams,
            requestId: bridgeRequestId,
            wait_for_page_info: actualWaitForPageInfo
        }
    };

    // 创建Promise等待响应。必须先注册监听和 pending，再发送命令；
    // 否则扩展秒回 command_result 时，服务端会错过响应并最终超时。
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const pending = pendingCommands.get(bridgeRequestId);
            if (pending?.fallbackTimer) {
                clearTimeout(pending.fallbackTimer);
            }
            pendingCommands.delete(bridgeRequestId);
            entry.ws.removeListener('message', messageListener);
            reject(new Error(`命令执行超时 (${command})`));
        }, 30000);

        // 注册等待
        pendingCommands.set(bridgeRequestId, {
            resolve,
            reject,
            timeout,
            waitForPageInfo: actualWaitForPageInfo,
            commandExecuted: false,
            executionMessage: null,
            commandResult: null,
            fallbackTimer: null
        });

        // 监听命令执行结果
        const messageListener = (message) => {
            try {
                const msg = JSON.parse(message);

                if (msg.type === 'command_result' && msg.data?.requestId === bridgeRequestId) {
                    const pending = pendingCommands.get(bridgeRequestId);
                    if (!pending) return;

                    if (msg.data.status === 'error') {
                        clearTimeout(pending.timeout);
                        if (pending.fallbackTimer) {
                            clearTimeout(pending.fallbackTimer);
                        }
                        pendingCommands.delete(bridgeRequestId);
                        entry.ws.removeListener('message', messageListener);
                        const error = new Error(msg.data.error || '命令执行失败');
                        error.code = msg.data.code || 'CHROME_COMMAND_ERROR';
                        error.details = msg.data.details || null;
                        reject(error);
                    } else if (!actualWaitForPageInfo) {
                        // 不需要等待页面信息，直接返回
                        clearTimeout(pending.timeout);
                        if (pending.fallbackTimer) {
                            clearTimeout(pending.fallbackTimer);
                        }
                        pendingCommands.delete(bridgeRequestId);
                        entry.ws.removeListener('message', messageListener);
                        resolve({
                            success: true,
                            message: msg.data.message || '命令执行成功',
                            result: msg.data.result, // 透传执行结果（如 HTML, JS 返回值, 网络日志等）
                            code: msg.data.code || null
                        });
                    } else {
                        // 命令执行成功，标记并短暂等待页面信息；若页面内容没有变化或站点阻断 content_script，不应拖到 30 秒超时
                        console.log(`[ChromeBridge] ✅ 命令执行成功，等待页面加载/刷新...`);
                        pending.commandExecuted = true;
                        pending.executionMessage = msg.data.message || '命令执行成功';
                        pending.commandResult = msg.data.result;
                        pending.fallbackTimer = setTimeout(() => {
                            const stillPending = pendingCommands.get(bridgeRequestId);
                            if (!stillPending || !stillPending.commandExecuted) return;
                            clearTimeout(stillPending.timeout);
                            pendingCommands.delete(bridgeRequestId);
                            entry.ws.removeListener('message', messageListener);
                            resolve({
                                success: true,
                                message: stillPending.executionMessage,
                                result: stillPending.commandResult,
                                page_info: pluginManager.staticPlaceholderValues.get("{{VCPChromePageInfo}}") || null,
                                page_info_meta: entry.lastPageInfo ? {
                                    snapshotId: entry.lastPageInfo.snapshotId,
                                    generatedAt: entry.lastPageInfo.generatedAt,
                                    url: entry.lastPageInfo.url,
                                    title: entry.lastPageInfo.title,
                                    elementCount: entry.lastPageInfo.elementCount
                                } : null,
                                page_info_fallback: true
                            });
                        }, Number.parseInt(cmdParams.pageInfoFallbackMs, 10) || 4000);
                    }
                }
            } catch (e) {
                console.error('[ChromeBridge] 解析消息失败:', e);
            }
        };

        entry.ws.on('message', messageListener);

        // 监听已经就绪后再发送命令，避免秒回竞态导致超时。
        entry.ws.send(JSON.stringify(commandMessage));
    });
}

async function runLifecycleCommand(command, params = {}) {
    switch (command) {
        case 'open_chrome': {
            const timeoutMs = Number.parseInt(params.timeoutMs, 10) || 10000;
            await browserRuntimeManager.ensureManagedBrowser();
            let client = await waitForManagedClient(timeoutMs);

            if (!client) {
                console.warn('[ChromeBridge] open_chrome 未等到 managed token 连接，准备重启 managed Chrome 后重试一次。');
                await browserRuntimeManager.closeManagedBrowser('open_chrome_unverified_restart');
                await browserRuntimeManager.ensureManagedBrowser();
                client = await waitForManagedClient(timeoutMs);
            }

            if (!client) {
                const diagnostics = getManagedConnectionDiagnostics();
                diagnostics.debugTargets = await browserRuntimeManager.getManagedBrowserDebugTargets().catch(error => ({
                    available: false,
                    error: error.message
                }));
                throw new Error(JSON.stringify({
                    plugin_error: 'managed Chrome 已启动/重启，但没有通过 token 校验的 managed 扩展连接。已拒绝把用户 Chrome 当作 managed 使用。',
                    diagnostics
                }));
            }
            return {
                success: true,
                message: 'managed Chrome 已启动并通过 token 校验连接',
                result: {
                    runtime: browserRuntimeManager.getManagedBrowserStatus(),
                    connectedManagedClient: summarizeClient(client)
                }
            };
        }

        case 'close_chrome': {
            const status = await browserRuntimeManager.closeManagedBrowser('tool_call');
            return {
                success: true,
                message: '已请求关闭 managed Chrome（不会关闭用户 Chrome）',
                result: status
            };
        }

        case 'browser_status': {
            return {
                success: true,
                message: '获取浏览器运行时状态成功',
                result: {
                    runtime: browserRuntimeManager.getManagedBrowserStatus(),
                    clients: getOpenClients().map(summarizeClient),
                    maxTabs: getMaxTabsLimit()
                }
            };
        }

        case 'keep_chrome_alive': {
            return {
                success: true,
                message: '已刷新 managed Chrome idle timer',
                result: browserRuntimeManager.touchManagedBrowser()
            };
        }

        case 'close_managed_tabs': {
            const client = await selectChromeClient({ browserTarget: 'managed' }, { allowAutoCreate: false });
            if (!client) {
                return { success: true, message: '当前没有 connected managed Chrome', result: { closed: false } };
            }
            const result = await executeSingleCommand(client, { command: 'close_tab' }, false, false);
            return {
                success: true,
                message: '已请求关闭 managed Chrome 当前活动标签页',
                result
            };
        }

        default:
            throw new Error(`未知生命周期指令: ${command}`);
    }
}

function summarizeClient(entry) {
    return {
        clientId: entry.clientId,
        clientKind: entry.clientKind,
        remoteAddress: entry.remoteAddress,
        connectedAt: entry.connectedAt,
        lastSeenAt: entry.lastSeenAt,
        permissionLevel: entry.permissionLevel,
        managedTokenValid: entry.managedTokenValid,
        extensionVersion: entry.extensionVersion,
        platform: entry.platform,
        capabilities: entry.capabilities,
        maxTabs: entry.maxTabs,
        activeTabInfo: entry.activeTabInfo
    };
}

async function normalizeScriptCommand(cmd) {
    if (cmd.command !== 'execute_saved_script') return cmd;

    if (!cmd.scriptName) {
        throw new Error('execute_saved_script 缺少 scriptName 参数');
    }

    // 确保文件名安全，防止路径穿越
    const safeScriptName = path.basename(cmd.scriptName);
    const scriptsDir = path.join(__dirname, 'ChromeScripts');
    const scriptPath = path.join(scriptsDir, safeScriptName);

    try {
        if (!fs.existsSync(scriptsDir)) {
            fs.mkdirSync(scriptsDir, { recursive: true });
        }

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`持久化脚本文件不存在: ${safeScriptName}，请确保它存放在 Plugin/ChromeBridge/ChromeScripts 目录下。`);
        }

        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        // 转换为 execute_script 命令，并将脚本内容填入 text 参数
        cmd.command = 'execute_script';
        cmd.text = scriptContent;
        console.log(`[ChromeBridge] 📄 成功读取持久化脚本: ${safeScriptName}，转换为 execute_script 执行`);
        return cmd;
    } catch (err) {
        throw new Error(`读取持久化脚本失败: ${err.message}`);
    }
}

function buildAiFriendlyTextResult(markdownText, details = null, extraContent = []) {
    const content = [
        { type: 'text', text: String(markdownText || '') }
    ];

    for (const item of extraContent) {
        if (item && typeof item === 'object') {
            content.push(item);
        }
    }

    const result = { content };
    if (details !== null && details !== undefined) {
        result.details = details;
    }

    // hybridservice/direct 插件会被 Plugin.js 解开 { status, result }。
    // 这里保持 result 为 { content: [...] }，让最终工具结果拥有 content 字段；
    // 不要让 result 直接等于数组，否则外层会把整个数组再次序列化进 text。
    return {
        status: 'success',
        result
    };
}

function stringifyForMarkdown(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function formatPrimitiveForMarkdown(value) {
    if (value === null) return '`null`';
    if (value === undefined) return '`undefined`';
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
        return `\`${String(value)}\``;
    }
    const text = String(value);
    if (text === '') return '（空）';
    if (text.includes('\n')) {
        return `\n\n${text}`;
    }
    return text;
}

function formatObjectAsMarkdown(value, options = {}) {
    const {
        level = 0,
        maxDepth = 5,
        maxArrayItems = 50,
        keyLabel = null
    } = options;

    const indent = '  '.repeat(level);
    const nestedIndent = '  '.repeat(level + 1);

    if (value === null || value === undefined || typeof value !== 'object') {
        const prefix = keyLabel ? `${indent}- ${keyLabel}: ` : '';
        return `${prefix}${formatPrimitiveForMarkdown(value)}`;
    }

    if (level >= maxDepth) {
        const compact = stringifyForMarkdown(value).replace(/\s+/g, ' ').trim();
        const prefix = keyLabel ? `${indent}- ${keyLabel}: ` : '';
        return `${prefix}${compact || '（空对象）'}`;
    }

    if (Array.isArray(value)) {
        const lines = [];
        if (keyLabel) {
            lines.push(`${indent}- ${keyLabel}:`);
        }
        if (value.length === 0) {
            lines.push(`${keyLabel ? nestedIndent : indent}- （空数组）`);
            return lines.join('\n');
        }

        value.slice(0, maxArrayItems).forEach((item, index) => {
            const itemLabel = `#${index + 1}`;
            if (item && typeof item === 'object') {
                lines.push(formatObjectAsMarkdown(item, {
                    level: keyLabel ? level + 1 : level,
                    maxDepth,
                    maxArrayItems,
                    keyLabel: itemLabel
                }));
            } else {
                lines.push(`${keyLabel ? nestedIndent : indent}- ${itemLabel}: ${formatPrimitiveForMarkdown(item)}`);
            }
        });

        if (value.length > maxArrayItems) {
            lines.push(`${keyLabel ? nestedIndent : indent}- ……已省略 ${value.length - maxArrayItems} 项`);
        }
        return lines.join('\n');
    }

    const entries = Object.entries(value);
    const lines = [];
    if (keyLabel) {
        lines.push(`${indent}- ${keyLabel}:`);
    }
    if (entries.length === 0) {
        lines.push(`${keyLabel ? nestedIndent : indent}- （空对象）`);
        return lines.join('\n');
    }

    for (const [key, item] of entries) {
        const currentLevel = keyLabel ? level + 1 : level;
        const currentIndent = '  '.repeat(currentLevel);

        if (item && typeof item === 'object') {
            lines.push(formatObjectAsMarkdown(item, {
                level: currentLevel,
                maxDepth,
                maxArrayItems,
                keyLabel: key
            }));
        } else {
            lines.push(`${currentIndent}- ${key}: ${formatPrimitiveForMarkdown(item)}`);
        }
    }

    return lines.join('\n');
}

function getScreenshotDataUrl(commandResult = {}) {
    const result = commandResult?.result || commandResult;
    const dataUrl = result?.dataUrl || result?.imageUrl || result?.url;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        return dataUrl;
    }
    return null;
}

function formatCommandResultAsMarkdown(commandResult = {}) {
    const lines = [];
    const success = commandResult.success !== false;

    lines.push(`## ChromeBridge 执行结果`);
    lines.push('');
    lines.push(`- 状态: ${success ? 'success' : 'error'}`);

    if (commandResult.message) {
        lines.push(`- 消息: ${commandResult.message}`);
    }

    if (commandResult.code) {
        lines.push(`- Code: ${commandResult.code}`);
    }

    if (commandResult.page_info) {
        lines.push('');
        lines.push('## 当前页面 Markdown');
        lines.push('');
        lines.push(String(commandResult.page_info));
    } else if (commandResult.result?.markdown) {
        lines.push('');
        lines.push('## 当前页面 Markdown');
        lines.push('');
        lines.push(String(commandResult.result.markdown));
    } else if (typeof commandResult.result === 'string') {
        lines.push('');
        lines.push('## Result');
        lines.push('');
        lines.push(commandResult.result);
    } else if (commandResult.result !== undefined) {
        const screenshotDataUrl = getScreenshotDataUrl(commandResult);
        const details = screenshotDataUrl
            ? { ...commandResult.result, dataUrl: '[omitted:data-image-url]' }
            : commandResult.result;
        lines.push('');
        lines.push('## Result');
        lines.push('');
        lines.push(formatObjectAsMarkdown(details));
    }

    if (commandResult.page_info_meta) {
        lines.push('');
        lines.push('## Page Info Meta');
        lines.push('');
        lines.push(formatObjectAsMarkdown(commandResult.page_info_meta));
    }

    return lines.join('\n');
}

function normalizeToolResultForAi(commandResult) {
    if (
        commandResult &&
        typeof commandResult === 'object' &&
        commandResult.status === 'success' &&
        Array.isArray(commandResult.result)
    ) {
        return {
            status: 'success',
            result: { content: commandResult.result }
        };
    }

    if (
        commandResult &&
        typeof commandResult === 'object' &&
        commandResult.status === 'success' &&
        commandResult.result &&
        typeof commandResult.result === 'object' &&
        Array.isArray(commandResult.result.content)
    ) {
        return commandResult;
    }

    if (
        commandResult &&
        typeof commandResult === 'object' &&
        Array.isArray(commandResult.content)
    ) {
        return {
            status: 'success',
            result: commandResult
        };
    }

    const screenshotDataUrl = getScreenshotDataUrl(commandResult);
    const extraContent = screenshotDataUrl
        ? [{
            type: 'image_url',
            image_url: {
                url: screenshotDataUrl
            }
        }]
        : [];

    const details = screenshotDataUrl && commandResult?.result
        ? {
            ...commandResult,
            result: {
                ...commandResult.result,
                dataUrl: '[omitted:data-image-url]'
            }
        }
        : commandResult;

    return buildAiFriendlyTextResult(formatCommandResultAsMarkdown(commandResult), details, extraContent);
}

// ========== 平台桥接（Douyin 等）命令支持 ==========

// 选择承载 extract_data/download_video 能力的桥接扩展客户端
function selectPlatformBridgeClient(params = {}) {
    const clients = getOpenClients();
    if (params.client_id) {
        const exact = connectedChromes.get(String(params.client_id));
        if (exact && isOpen(exact.ws)) return exact;
        console.warn(`[ChromeBridge] 指定的 client_id "${params.client_id}" 未找到，回退到能力匹配`);
    }

    // 优先选择声明了 extract_data / douyin_extract 能力的扩展
    const capable = clients.find(entry =>
        Array.isArray(entry.capabilities) &&
        (entry.capabilities.includes('extract_data') || entry.capabilities.includes('douyin_extract'))
    );
    if (capable) return capable;

    // 其次选择最近活跃的客户端（VCPBridge-Extension 会定期上报页面信息）
    const sorted = [...clients].sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    return sorted[0] || null;
}

function formatExtractDataAsMarkdown(result) {
    const lines = [];
    lines.push('## 页面数据提取结果');
    lines.push('');
    lines.push(`- 类型: ${result.extract_type || 'unknown'}`);
    if (result.source_url) lines.push(`- 来源 URL: ${result.source_url}`);
    if (result.page_type) lines.push(`- 页面类型: ${result.page_type}`);
    if (result.extracted_at) lines.push(`- 提取时间: ${result.extracted_at}`);
    if (result.data) {
        lines.push('');
        lines.push('### 提取的数据');
        lines.push('');
        lines.push(formatObjectAsMarkdown(result.data, { maxDepth: 6 }));
    }
    return lines.join('\n');
}

// 发送 extract_data 命令并等待扩展返回 extract_result（60 秒超时）
async function executeExtractCommand(entry, params) {
    const requestId = `cb-extract-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const extractType = params.extract_type || 'douyin_full';

    const auth = authorizeChromeCommand(entry, 'extract_data');
    if (!auth.allowed) throw new Error(auth.reason);

    console.log(`[ChromeBridge] 🕵️ 数据提取请求: type=${extractType}, url=${params.url || '当前页面'}, requestId=${requestId}`);

    const commandMessage = {
        type: 'command',
        data: {
            requestId,
            command: 'extract_data',
            extract_type: extractType,
            url: params.url || null,
            options: {
                comment_count: Number.parseInt(params.comment_count, 10) || 50,
                include_replies: String(params.include_replies).toLowerCase() !== 'false',
                sort_by: params.sort_by || 'likes',
                keyword: params.keyword || null,
                search_type: params.search_type || null,
                maxRounds: params.max_rounds ? Number.parseInt(params.max_rounds, 10) : (params.maxRounds ? Number.parseInt(params.maxRounds, 10) : undefined),
                maxItems: params.max_items ? Number.parseInt(params.max_items, 10) : (params.maxItems ? Number.parseInt(params.maxItems, 10) : undefined),
                danmaku_num: params.danmaku_num ? Number.parseInt(params.danmaku_num, 10) : undefined,
                portrait_count: params.portrait_count ? Number.parseInt(params.portrait_count, 10) : undefined
            }
        }
    };

    entry.ws.send(JSON.stringify(commandMessage));

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error(`数据提取超时 (${extractType})`));
        }, 60000);

        pendingCommands.set(requestId, {
            resolve,
            reject,
            timeout,
            waitForPageInfo: false,
            commandExecuted: false,
            executionMessage: null,
            fallbackTimer: null
        });
    });
}

// 发送 download_video 命令并等待扩展返回 download_result（60 秒超时）
async function executeDownloadCommand(entry, params) {
    const requestId = `cb-download-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const auth = authorizeChromeCommand(entry, 'download_video');
    if (!auth.allowed) throw new Error(auth.reason);

    console.log(`[ChromeBridge] ⬇️ 视频下载请求: url=${params.url || '当前页面'}, requestId=${requestId}`);

    const commandMessage = {
        type: 'command',
        data: {
            requestId,
            command: 'download_video',
            url: params.url || null,
            filename: params.filename || null
        }
    };

    entry.ws.send(JSON.stringify(commandMessage));

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('视频下载请求超时'));
        }, 60000);

        pendingCommands.set(requestId, {
            resolve,
            reject,
            timeout,
            waitForPageInfo: false,
            commandExecuted: false,
            executionMessage: null,
            fallbackTimer: null
        });
    });
}

// 读取浏览器投喂队列（读取后清空）
function handleGetFeed() {
    if (feedQueue.length === 0) {
        return {
            success: true,
            message: '当前没有待处理的投喂数据。',
            result: { feeds: [], count: 0 }
        };
    }

    const feeds = [...feedQueue];
    feedQueue.length = 0;
    console.log(`[ChromeBridge] 📤 Agent读取了 ${feeds.length} 条投喂数据`);

    return {
        success: true,
        message: `共有 ${feeds.length} 条来自浏览器的投喂数据。`,
        result: { feeds, count: feeds.length }
    };
}

function handleGetStatus() {
    return {
        success: true,
        message: '获取 ChromeBridge 状态成功',
        result: {
            connected_chromes: getOpenClients().map(summarizeClient),
            feed_queue_size: feedQueue.length,
            maxTabs: getMaxTabsLimit()
        }
    };
}

// ========== 抖音字幕 ASR 转写（视频无自带字幕时启用） ==========

function getFfmpegPath() {
    const candidates = [
        path.join(__dirname, '..', '..', 'bin', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(__dirname, '..', '..', '..', 'VCPChat', 'bin', 'ffmpeg.exe'),
        'ffmpeg'
    ];
    for (const candidate of candidates) {
        try {
            if (candidate === 'ffmpeg' || fs.existsSync(candidate)) return candidate;
        } catch (_) {
            // ignore
        }
    }
    return 'ffmpeg';
}

// 下载无水印视频 → ffmpeg 抽音频 → 调 OpenAI 兼容转写接口，返回带时间戳字幕
function asrConfig(name, fallback) {
    const cfgValue = pluginConfig ? pluginConfig[name] : undefined;
    return (cfgValue !== undefined && cfgValue !== null && cfgValue !== '') ? cfgValue : (process.env[name] || fallback);
}

async function transcribeVideoWithAsr(playUrl) {
    const baseUrl = String(asrConfig('DOUYIN_ASR_BASE_URL', 'https://api.openai.com/v1')).replace(/\/+$/, '');
    const apiKey = String(asrConfig('DOUYIN_ASR_API_KEY', '') || '').trim();
    const model = String(asrConfig('DOUYIN_ASR_MODEL', 'whisper-1')).trim();
    const timeoutMs = Number.parseInt(asrConfig('DOUYIN_ASR_TIMEOUT_MS', '300000'), 10) || 300000;
    if (!apiKey) throw new Error('DOUYIN_ASR_API_KEY 未配置');

    console.log(`[ChromeBridge] [ASR] 开始转写: model=${model}, baseUrl=${baseUrl}, timeoutMs=${timeoutMs}`);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vcp-douyin-asr-'));
    const videoPath = path.join(tmpDir, 'input.mp4');
    const wavPath = path.join(tmpDir, 'audio.wav');
    try {
        // 1. 下载无水印视频（带抖音 Referer/UA）
        const downloadController = new AbortController();
        const downloadTimer = setTimeout(() => downloadController.abort(), timeoutMs);
        let videoResp;
        try {
            videoResp = await fetch(playUrl, {
                signal: downloadController.signal,
                headers: {
                    'Referer': 'https://www.douyin.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
        } finally {
            clearTimeout(downloadTimer);
        }
        if (!videoResp.ok) throw new Error(`视频下载失败 HTTP ${videoResp.status}`);
        const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
        await fs.promises.writeFile(videoPath, videoBuffer);
        console.log(`[ChromeBridge] [ASR] 视频已下载: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);

        // 2. ffmpeg 抽音频为 16k 单声道 wav
        await execFileAsync(getFfmpegPath(), ['-y', '-i', videoPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], { timeout: 120000 });
        console.log(`[ChromeBridge] [ASR] 音频抽取完成: ${(await fs.promises.stat(wavPath)).size / 1024 / 1024 > 1 ? ((await fs.promises.stat(wavPath)).size / 1024 / 1024).toFixed(1) + ' MB' : (await fs.promises.stat(wavPath)).size + ' bytes'}`);

        // 3. 调 OpenAI 兼容转写接口（verbose_json 带分段时间戳）
        const form = new FormData();
        form.append('file', new Blob([await fs.promises.readFile(wavPath)], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', model);
        form.append('response_format', 'verbose_json');

        const asrController = new AbortController();
        const asrTimer = setTimeout(() => asrController.abort(), timeoutMs);
        let asrResp;
        try {
            asrResp = await fetch(`${baseUrl}/audio/transcriptions`, {
                method: 'POST',
                signal: asrController.signal,
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: form
            });
        } finally {
            clearTimeout(asrTimer);
        }
        const asrJson = await asrResp.json().catch(() => ({}));
        if (!asrResp.ok) {
            throw new Error(`ASR 接口错误 HTTP ${asrResp.status}: ${JSON.stringify(asrJson).slice(0, 300)}`);
        }

        const segments = Array.isArray(asrJson.segments)
            ? asrJson.segments
                .map(s => ({
                    start: Number(s.start || 0),
                    end: Number(s.end || 0),
                    text: String(s.text || '').trim()
                }))
                .filter(s => s.text)
            : [];

        const result = {
            provider: 'openai-compatible',
            full_text: String(asrJson.text || ''),
            segments
        };
        console.log(`[ChromeBridge] [ASR] 转写成功: text=${result.full_text.length} 字符, segments=${result.segments.length}`);
        return result;
    } finally {
        // 转写完成后立即删除音频与视频临时文件，避免占用磁盘；
        // 即使中途失败（下载/ffmpeg/接口错误），也会走到这里清理
        for (const filePath of [wavPath, videoPath]) {
            try {
                await fs.promises.unlink(filePath);
            } catch (_) {
                // 文件可能尚未创建，忽略
            }
        }
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (_) {
            // ignore
        }
    }
}

// douyin_captions 提取后处理：无自带字幕且配置了 ASR 时自动转写
async function maybeTranscribeCaptions(extractResult) {
    const data = extractResult?.data || {};
    if (data.status !== 'no_builtin_subtitles' || !data.play_url) {
        return extractResult;
    }

    const asrEnabled = String(asrConfig('DOUYIN_ASR_ENABLED', 'false')).toLowerCase() === 'true';
    if (!asrEnabled) {
        data.asr_note = '视频无自带字幕，play_url 已就绪；设置 DOUYIN_ASR_ENABLED=true 与 DOUYIN_ASR_API_KEY 后可自动转写';
        return extractResult;
    }

    try {
        const captions = await transcribeVideoWithAsr(data.play_url);
        if (captions && (captions.full_text || (captions.segments && captions.segments.length))) {
            data.status = 'asr_transcribed';
            data.captions = captions.segments || [];
            data.full_text = captions.full_text || '';
            data.asr_provider = captions.provider || 'openai-compatible';
            data.needs_asr = false;
        } else {
            data.asr_warning = 'ASR 未返回有效结果';
        }
    } catch (error) {
        data.asr_error = String(error?.message || error);
        data.asr_note = 'ASR 转写失败，play_url 已保留，可手动转写';
    }
    return extractResult;
}

// Direct调用接口（hybridservice 使用 processToolCall）
async function processToolCall(params) {
    // 提取所有命令参数
    const commands = [];
    let commandIndex = 1;

    // 检查是否有编号的命令（command1, command2, ...）
    while (params[`command${commandIndex}`]) {
        commands.push(buildCommandFromParams(params, String(commandIndex)));
        commandIndex++;
    }

    // 如果没有编号命令，检查单个命令
    if (commands.length === 0 && params.command) {
        commands.push(buildCommandFromParams(params));
    }

    if (commands.length === 0) {
        throw new Error('未提供任何命令参数');
    }

    if (commands.length === 1 && LIFECYCLE_COMMANDS.has(commands[0].command)) {
        return normalizeToolResultForAi(await runLifecycleCommand(commands[0].command, params));
    }

    // 平台桥接命令（Douyin 等）：单命令走专用通道，不进入通用命令链
    if (commands.length === 1) {
        const single = commands[0];
        if (single.command === 'get_feed') {
            return normalizeToolResultForAi(handleGetFeed());
        }
        if (single.command === 'get_status') {
            return normalizeToolResultForAi(handleGetStatus());
        }
        if (single.command === 'extract_data' || single.command === 'download_video') {
            const bridgeEntry = selectPlatformBridgeClient(params);
            if (!bridgeEntry) {
                throw new Error('没有可用的 VCPBridge-Extension 连接。请先安装并连接 VCPBridge 扩展（Plugin/ChromeBridge/VCPBridge-Extension）。');
            }
            if (single.command === 'extract_data') {
                let extractResult = await executeExtractCommand(bridgeEntry, params);
                if (String(params.extract_type || 'douyin_full') === 'douyin_captions') {
                    extractResult = await maybeTranscribeCaptions(extractResult);
                }
                return buildAiFriendlyTextResult(formatExtractDataAsMarkdown(extractResult), extractResult);
            }
            const downloadResult = await executeDownloadCommand(bridgeEntry, params);
            return buildAiFriendlyTextResult(formatCommandResultAsMarkdown(downloadResult), downloadResult);
        }
    }

    console.log(`[ChromeBridge] 📋 收到 ${commands.length} 个命令，准备串行执行`);

    const isCommandChain = commands.length > 1;
    let chromeEntry = null;

    // 串行执行所有命令
    for (let i = 0; i < commands.length; i++) {
        const cmd = await normalizeScriptCommand(commands[i]);
        const isLastCommand = (i === commands.length - 1);

        console.log(`[ChromeBridge] 执行命令 ${i + 1}/${commands.length}: ${cmd.command}`);

        if (isWaitCommand(cmd.command)) {
            const waitMs = getWaitDurationMs(cmd);
            console.log(`[ChromeBridge] ⏱️ 串行等待 ${waitMs}ms 后继续执行后续指令`);
            await sleep(waitMs);
            if (isLastCommand) {
                return normalizeToolResultForAi({
                    success: true,
                    message: `已等待 ${waitMs}ms`,
                    result: { waitMs }
                });
            }
            continue;
        }

        if (LIFECYCLE_COMMANDS.has(cmd.command)) {
            const lifecycleResult = await runLifecycleCommand(cmd.command, params);
            if (isLastCommand) return normalizeToolResultForAi(lifecycleResult);
            continue;
        }

        if (!chromeEntry || cmd.browserTarget) {
            chromeEntry = await selectChromeClient(cmd, { allowAutoCreate: true });
        }

        if (!chromeEntry) {
            throw new Error('没有可用的Chrome浏览器。请确认 VCP_BROWSER_RUNTIME_ENABLED=true 或手动连接 VCPChrome 扩展。');
        }

        await enforceManagedTabLimit(chromeEntry, cmd);

        // 最后一个命令需要等待并返回页面信息
        // open_url 在命令链中时总是需要等待页面加载完成（通过 isInCommandChain 参数）
        const result = await executeSingleCommand(
            chromeEntry,
            cmd,
            isLastCommand,  // waitForPageInfo - 只有最后一个命令返回页面信息
            isCommandChain  // isInCommandChain - 命令链中的 open_url 需要等待页面加载
        );

        console.log(`[ChromeBridge] ✅ 命令 ${i + 1}/${commands.length} 完成`);

        // 如果是最后一个命令，它的 Promise 已经 resolve 并返回结果
        if (isLastCommand) {
            return normalizeToolResultForAi(result);
        }
    }
}

async function executeManagedCommand(cmdParams, options = {}) {
    const client = await selectChromeClient({ ...cmdParams, browserTarget: 'managed' }, { allowAutoCreate: options.allowAutoCreate !== false });
    if (!client) {
        throw new Error('managed Chrome 未连接');
    }

    await enforceManagedTabLimit(client, cmdParams);
    return executeSingleCommand(client, cmdParams, options.waitForPageInfo === true, options.isInCommandChain === true);
}

function shutdown() {
    console.log('[ChromeBridge] 关闭中...');

    // 清理所有待处理的命令
    pendingCommands.forEach((pending, requestId) => {
        clearTimeout(pending.timeout);
        pending.reject(new Error('插件正在关闭'));
    });
    pendingCommands.clear();
    feedQueue.length = 0;

    connectedChromes.clear();
}

module.exports = {
    initialize,
    registerRoutes,
    handleNewClient,
    handleClientMessage,
    processToolCall,
    executeManagedCommand,
    selectChromeClient,
    authorizeChromeCommand,
    shutdown
};
