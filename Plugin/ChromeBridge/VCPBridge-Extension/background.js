
// VCPBridge Extension - Background Service Worker
// 核心职责：WebSocket通信 + 命令分发 + 右键菜单 + 抖音视频下载
// v1.5.5 - 增强下载 URL 验证与诊断日志
// v1.5.4 - 修复下载权限问题（添加 downloads.open 权限）
// v1.5.3 - 简化 API 域名匹配逻辑，修复视频下载失效问题
// v1.5.2 - 修复评论 API 域名匹配（支持 mcs.zijieapi.com）
// v1.5.0 - 评论 API 嗅探增强：投喂数据包含 comments 字段与评论预览支持
// v1.3.2 - 修复预热play_url回流断裂
// v1.3.1 - 修复致命bug：downloadCurrentVideo消息处理器函数签名不匹配

const EXTENSION_RUNTIME_VERSION = '1.7.0';

let ws = null;
let wsHost = 'localhost:6015';
let vcpKey = '';
let isConnected = false;
let reconnectTimer = null;
const RECONNECT_INTERVAL = 5000;
const KEEPALIVE_ALARM_NAME = 'vcpbridge-keepalive';

// managed Chrome runtime identity (provided by server via managed-runtime-config.json)
let runtimeIdentity = {
  clientKind: 'user',
  managedRuntime: false,
  managedToken: null,
  maxTabs: 8
};
let runtimeConnectionConfig = {
  serverUrl: null,
  vcpKey: null
};

function applyManagedRuntimeConfig(config, source = 'unknown') {
  if (!config || config.managedRuntime !== true || !config.managedToken) return null;
  runtimeIdentity = {
    ...runtimeIdentity,
    clientKind: 'managed',
    managedRuntime: true,
    managedToken: String(config.managedToken),
    maxTabs: Math.max(1, Number.parseInt(config.maxTabs, 10) || runtimeIdentity.maxTabs)
  };
  runtimeConnectionConfig = {
    serverUrl: config.serverUrl || `ws://${wsHost}`,
    vcpKey: config.vcpKey || ''
  };
  if (runtimeConnectionConfig.vcpKey) vcpKey = runtimeConnectionConfig.vcpKey;
  if (config.serverUrl) {
    wsHost = String(config.serverUrl).replace(/^wss?:\/\//, '');
  }
  chrome.storage.local.set({
    serverUrl: runtimeConnectionConfig.serverUrl,
    vcpKey: runtimeConnectionConfig.vcpKey,
    clientKind: runtimeIdentity.clientKind,
    managedRuntime: true,
    managedToken: runtimeIdentity.managedToken,
    maxTabs: runtimeIdentity.maxTabs
  }).catch(() => {});
  console.log('[VCPBridge] applied managed runtime config, source=' + source);
  return config;
}

async function loadManagedRuntimeConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL('managed-runtime-config.json'), { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      const applied = applyManagedRuntimeConfig(config, 'web_accessible_resource');
      if (applied) return applied;
    }
  } catch (error) {
    console.log('[VCPBridge] managed-runtime-config.json unavailable, trying storage fallback:', error.message);
  }

  try {
    const result = await chrome.storage.local.get(['serverUrl', 'vcpKey', 'clientKind', 'managedRuntime', 'managedToken', 'maxTabs']);
    if (result && result.managedRuntime === true && result.managedToken) {
      const applied = applyManagedRuntimeConfig({
        serverUrl: result.serverUrl,
        vcpKey: result.vcpKey,
        clientKind: result.clientKind,
        managedRuntime: result.managedRuntime,
        managedToken: result.managedToken,
        maxTabs: result.maxTabs
      }, 'chrome.storage.local');
      if (applied) return applied;
    }
  } catch (error) {
    console.warn('[VCPBridge] storage managed config read failed:', error.message);
  }

  return null;
}

// ========== WebSocket 连接管理 ==========

async function loadConfig() {
  const managedConfig = await loadManagedRuntimeConfig();
  if (managedConfig) return;
  const result = await chrome.storage.local.get(['vcpWsHost', 'vcpKey']);
  if (result.vcpWsHost) wsHost = result.vcpWsHost;
  if (result.vcpKey) vcpKey = result.vcpKey;
}

function getWsUrl() {
  const host = runtimeConnectionConfig.serverUrl || `ws://${wsHost}`;
  return `${host}/vcp-chrome-observer/VCP_Key=${vcpKey}`;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (!vcpKey) {
    console.warn('[VCPBridge] 未配置 VCP_Key，无法连接。请在扩展设置中填入密钥。');
    return;
  }

  const url = getWsUrl();
  console.log(`[VCPBridge] 正在连接: ${url.replace(vcpKey, '***')}`);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[VCPBridge] WebSocket创建失败:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    console.log('[VCPBridge] ✅ 已连接到VCP服务器（ChromeObserver通道）');
    chrome.runtime.sendMessage({ type: 'connectionStatus', connected: true }).catch(() => {});

    sendToServer({
      type: 'clientHello',
      data: {
        clientKind: runtimeIdentity.clientKind,
        extensionVersion: EXTENSION_RUNTIME_VERSION,
        capabilities: ['extract_data', 'download_video', 'feed_data', 'douyin_extract', 'tabs'],
        managedRuntime: runtimeIdentity.managedRuntime,
        managedToken: runtimeIdentity.managedToken,
        maxTabs: runtimeIdentity.maxTabs
      }
    });

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (e) {
      console.error('[VCPBridge] 消息解析失败:', e);
    }
  };

  ws.onclose = () => {
    isConnected = false;
    console.log('[VCPBridge] ❌ 连接断开');
    chrome.runtime.sendMessage({ type: 'connectionStatus', connected: false }).catch(() => {});
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[VCPBridge] WebSocket错误:', error);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL);
}

function setupKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 1 });
  } catch (e) {
    console.warn('[VCPBridge] alarms API 不可用:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupKeepaliveAlarm();
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  setupKeepaliveAlarm();
  connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === KEEPALIVE_ALARM_NAME) {
    connect();
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'content_ready') {
    connect();
  }
  if (message && message.type === 'get_status') {
    sendResponse({ connected: isConnected, wsHost, vcpKey: vcpKey ? '已配置' : '未配置', managed: runtimeIdentity.managedRuntime });
    return;
  }
  return undefined;
});

function sendToServer(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  console.warn('[VCPBridge] 未连接，无法发送消息');
  return false;
}

// ========== 服务端命令处理 ==========

function handleServerMessage(message) {
  if (message.type === 'connection_ack') {
    console.log('[VCPBridge] 收到服务器连接确认:', message.message);
    return;
  }

  if (message.type === 'heartbeat_ack') {
    return;
  }

  if (message.type === 'command') {
    const { requestId, command, extract_type, url, target, text, options, wait_for_page_info } = message.data;

    console.log(`[VCPBridge] 收到命令: ${command}, requestId: ${requestId}`);

    if (command === 'extract_data') {
      handleExtractCommand(requestId, extract_type, url, options);
    } else if (command === 'open_url') {
      handleOpenUrl(requestId, url, wait_for_page_info);
    } else if (command === 'click') {
      handleClick(requestId, target, wait_for_page_info);
    } else if (command === 'type') {
      handleType(requestId, target, text, wait_for_page_info);
    } else if (command === 'download_video') {
      handleDownloadVideoFromServer(requestId, url);
    } else if (command === 'list_tabs') {
      handleListTabs(requestId);
    } else if (command === 'switch_tab') {
      handleSwitchTab(requestId, target);
    } else if (command === 'close_tab') {
      handleCloseTab(requestId, target);
    } else {
      sendToServer({
        type: 'command_result',
        data: { requestId, status: 'error', error: `未知命令: ${command}` }
      });
    }
  }
}

// 处理数据提取命令
async function handleExtractCommand(requestId, extractType, url, options) {
  try {
    let tabId;

    // douyin_search 未提供 url 时，根据 keyword 自动拼搜索页地址
    if (extractType === 'douyin_search' && !url) {
      const keyword = String(options?.keyword || '').trim();
      if (!keyword) {
        sendToServer({
          type: 'extract_result',
          data: { requestId, status: 'error', error: 'douyin_search 需要提供 keyword 参数' }
        });
        return;
      }
      url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}`;
      const searchType = String(options?.search_type || 'general').trim().toLowerCase();
      if (['video', 'user', 'general'].includes(searchType)) {
        url += `?type=${encodeURIComponent(searchType)}`;
      }
    }

    // douyin_hot / douyin_feed 未提供 url 时，打开对应默认页
    if (extractType === 'douyin_hot' && !url) {
      url = 'https://www.douyin.com/hot';
    } else if (extractType === 'douyin_feed' && !url) {
      url = 'https://www.douyin.com/';
    }

    if (url) {
      const tab = await chrome.tabs.create({ url, active: true });
      tabId = tab.id;
      await waitForTabLoad(tabId);
      await sleep(2000);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendToServer({
          type: 'extract_result',
          data: { requestId, status: 'error', error: '没有活动的标签页' }
        });
        return;
      }
      tabId = tab.id;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'extract',
      extractType,
      options
    });

    const tab = await chrome.tabs.get(tabId);

    sendToServer({
      type: 'extract_result',
      data: {
        requestId,
        status: 'success',
        extract_type: extractType,
        extractedData: response.data,
        sourceUrl: tab.url
      }
    });
  } catch (e) {
    console.error('[VCPBridge] 数据提取失败:', e);
    sendToServer({
      type: 'extract_result',
      data: { requestId, status: 'error', error: e.message }
    });
  }
}

// 处理打开URL命令
async function handleOpenUrl(requestId, url, waitForPageInfo) {
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    await waitForTabLoad(tab.id);

    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'success', message: `成功打开URL: ${url}` }
    });

    if (waitForPageInfo) {
      await sleep(1500);
      await requestPageInfo(tab.id);
    }
  } catch (e) {
    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'error', error: e.message }
    });
  }
}

// 处理点击命令
async function handleClick(requestId, target, waitForPageInfo) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('没有活动的标签页');

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'click', target });

    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'success', message: response?.message || `已点击: ${target}` }
    });

    if (waitForPageInfo) {
      await sleep(1500);
      await requestPageInfo(tab.id);
    }
  } catch (e) {
    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'error', error: e.message }
    });
  }
}

// 处理输入命令
async function handleType(requestId, target, text, waitForPageInfo) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('没有活动的标签页');

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'type', target, text });

    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'success', message: response?.message || `已输入文本到: ${target}` }
    });

    if (waitForPageInfo) {
      await sleep(1500);
      await requestPageInfo(tab.id);
    }
  } catch (e) {
    sendToServer({
      type: 'command_result',
      data: { requestId, status: 'error', error: e.message }
    });
  }
}

function sendCommandError(requestId, error) {
  sendToServer({
    type: 'command_result',
    data: { requestId, status: 'error', error: error?.message || String(error) }
  });
}

// 处理标签页列表命令
async function handleListTabs(requestId) {
  try {
    const tabs = await chrome.tabs.query({});
    const tabList = tabs.map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active
    }));
    sendToServer({
      type: 'command_result',
      data: {
        requestId,
        status: 'success',
        message: `获取标签页列表成功，当前 ${tabList.length}/${runtimeIdentity.maxTabs} 个标签页`,
        result: {
          tabs: tabList,
          count: tabList.length,
          maxTabs: runtimeIdentity.maxTabs,
          managedRuntime: runtimeIdentity.managedRuntime
        }
      }
    });
  } catch (e) {
    sendCommandError(requestId, e);
  }
}

// 按 ID 优先、标题/URL 模糊匹配定位标签页
function resolveTabTarget(tabs, target) {
  if (!target) return tabs.find(t => t.active) || null;

  const tabId = parseInt(String(target), 10);
  if (!isNaN(tabId)) {
    const byId = tabs.find(t => t.id === tabId);
    if (byId) return byId;
  }

  const normalized = String(target).toLowerCase();
  return tabs.find(t =>
    (t.title && String(t.title).toLowerCase().includes(normalized)) ||
    (t.url && String(t.url).toLowerCase().includes(normalized))
  ) || null;
}

// 处理切换标签页命令
async function handleSwitchTab(requestId, target) {
  try {
    if (!target) throw new Error('switch_tab 缺少 target 参数');
    const tabs = await chrome.tabs.query({});
    const targetTab = resolveTabTarget(tabs, target);
    if (!targetTab) throw new Error(`未找到匹配的标签页: ${target}`);

    const updated = await chrome.tabs.update(targetTab.id, { active: true });
    sendToServer({
      type: 'command_result',
      data: {
        requestId,
        status: 'success',
        message: `成功切换到标签页: ${updated.title || updated.url}`,
        result: { id: updated.id, title: updated.title, url: updated.url }
      }
    });
  } catch (e) {
    sendCommandError(requestId, e);
  }
}

// 处理关闭标签页命令（不填 target 时关闭当前活动标签页）
async function handleCloseTab(requestId, target) {
  try {
    const tabs = await chrome.tabs.query({});
    const targetTab = resolveTabTarget(tabs, target);
    if (!targetTab) throw new Error(`未找到要关闭的标签页: ${target || '当前活动标签页'}`);

    await chrome.tabs.remove(targetTab.id);
    sendToServer({
      type: 'command_result',
      data: {
        requestId,
        status: 'success',
        message: `成功关闭标签页: ${targetTab.title || targetTab.url}`,
        result: { id: targetTab.id, title: targetTab.title, url: targetTab.url, closed: true }
      }
    });
  } catch (e) {
    sendCommandError(requestId, e);
  }
}

// 请求Content Script发送页面信息
async function requestPageInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' });
    if (response && response.markdown) {
      sendToServer({
        type: 'pageInfoUpdate',
        data: { markdown: response.markdown }
      });
    }
  } catch (e) {
    console.warn('[VCPBridge] 获取页面信息失败:', e.message);
  }
}

// ========== 抖音视频下载 ==========

// API 参数缓存（参考成功插件的 webRequest 拦截模式）
const douyinDetailParamCache = new Map();
const MAX_PARAM_CACHE = 20;

// 下载上下文追踪
const douyinDownloadContextById = new Map();
const douyinBlobUrlByDownloadId = new Map();

// DNR 规则管理
const DOUYIN_DNR_RULE_BASE = 18000;
let douyinDnrSeq = 0;
const douyinDnrRuleByTab = new Map();

/**
 * 从 webRequest 拦截到的 URL 中缓存 API 参数
 * 参考成功插件：它们通过 webRequest 监听 aweme/detail 请求，
 * 缓存其中的签名参数（a_bogus, msToken 等），后续复用
 */
function cacheDouyinDetailParamsFromUrl(rawUrl = '', source = 'webRequest') {
  try {
    const url = new URL(rawUrl);
    if (!/aweme\/v1\/web\/aweme\/detail/i.test(url.toString())) return false;
    const entries = [];
    const seen = new Set();
    for (const [key, value] of url.searchParams.entries()) {
      const k = String(key || '').trim();
      if (!k || k === 'aweme_id' || seen.has(k)) continue;
      seen.add(k);
      entries.push([k, String(value ?? '')]);
    }
    if (entries.length < 8) return false;

    douyinDetailParamCache.set(Date.now(), { params: entries, source });

    // 限制缓存大小
    while (douyinDetailParamCache.size > MAX_PARAM_CACHE) {
      const oldestKey = douyinDetailParamCache.keys().next().value;
      douyinDetailParamCache.delete(oldestKey);
    }

    console.log('[VCPBridge] 已缓存抖音详情参数:', {
      source,
      paramCount: entries.length,
      cacheSize: douyinDetailParamCache.size
    });
    return true;
  } catch (e) {
    return false;
  }
}

function getLatestDouyinDetailParams() {
  const entries = Array.from(douyinDetailParamCache.entries()).sort((a, b) => b[0] - a[0]);
  return entries[0]?.[1] || null;
}

function buildAwemeDetailUrl(awemeId, cachedEntry) {
  const url = new URL('https://www.douyin.com/aweme/v1/web/aweme/detail/');
  url.searchParams.set('aweme_id', awemeId);
  if (cachedEntry?.params) {
    for (const [key, value] of cachedEntry.params) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

// ========== Referer 规则管理 ==========

function getDouyinReferer(sourceUrl, awemeId) {
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) return sourceUrl;
  if (awemeId) return `https://www.douyin.com/video/${awemeId}`;
  return 'https://www.douyin.com/';
}

async function setDouyinRefererRule(tabId, referer) {
  if (!Number.isInteger(tabId)) return;
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;

  const prevRuleId = douyinDnrRuleByTab.get(tabId);
  if (prevRuleId) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRules: [prevRuleId] });
    } catch (e) {}
  }

  const ruleId = DOUYIN_DNR_RULE_BASE + (douyinDnrSeq++ % 1000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: referer }
          ]
        },
        condition: {
          regexFilter: 'https?://([^/]*\\.)?(douyin|byteimg|bytedance)[^/]*\\/.*',
          tabIds: [tabId],
          resourceTypes: ['media', 'xmlhttprequest', 'other']
        }
      }]
    });
    douyinDnrRuleByTab.set(tabId, ruleId);
  } catch (e) {
    console.warn('[VCPBridge] 设置referer规则失败:', e);
  }
}

async function clearDouyinRefererRule(tabId) {
  if (!Number.isInteger(tabId)) return;
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;

  const ruleId = douyinDnrRuleByTab.get(tabId);
  if (!ruleId) return;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRules: [ruleId] });
  } catch (e) {}
  douyinDnrRuleByTab.delete(tabId);
}

// ========== 视频 URL 处理 ==========

function normalizeVideoUrl(url = '') {
  return String(url || '')
    .trim()
    .replace('playwm', 'play')
    .replace(/^http:\/\//i, 'https://');
}

function isLikelyDirectVideoUrl(url = '') {
  const value = String(url || '').trim();
  if (!value) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  if (/^https?:\/\/www\.douyin\.com\/?\?/i.test(value)) return false;
  if (/^https?:\/\/www\.douyin\.com\/[^?#]*$/i.test(value) && !/\/aweme\/|\/play\/|\/video\//i.test(value)) return false;
  return true;
}

// ========== 预热请求 ==========

async function requestContentScriptPrewarmDetailParams(tabId, awemeId, sourceUrl) {
  if (!Number.isInteger(tabId) || !awemeId) return null;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'prewarm_douyin_aweme_detail',
      awemeId,
      sourceUrl
    });
    if (!response?.success) return null;
    return {
      success: true,
      awemeId: String(response.awemeId || awemeId || ''),
      sourceUrl: String(response.sourceUrl || sourceUrl || ''),
      url: String(response.url || ''),
      status: String(response.status || 'ok'),
      play_url: normalizeVideoUrl(response.play_url || ''),
      desc: String(response.desc || ''),
      author_name: String(response.author_name || ''),
      has_aweme_detail: !!response.has_aweme_detail
    };
  } catch (e) {
    console.warn('[VCPBridge] 页面预热详情参数失败:', e?.message || e);
    return null;
  }
}

// ========== 核心下载函数 ==========

/**
 * 处理来自内容脚本的下载请求（新版：接收纯字符串字段）
 * 消息格式: { video_id, title, author_name, cached_play_url, source_url, page_type }
 * 全部是纯字符串，不含任何复杂对象，避免序列化问题
 */
async function handleDownloadVideo(requestId, msg) {
  let tabId;
  let sourceUrl = String(msg.source_url || '');

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && Number.isInteger(activeTab.id)) {
      tabId = activeTab.id;
      if (!sourceUrl) sourceUrl = activeTab.url || '';
    }

    const videoId = String(msg.video_id || '');
    const title = String(msg.title || '');
    const authorName = String(msg.author_name || '');
    const cachedPlayUrl = normalizeVideoUrl(msg.cached_play_url || '');
    const pageType = String(msg.page_type || '');

    // 从 URL 中也尝试提取 aweme_id
    const awemeIdFromUrl = extractAwemeIdFromUrl(sourceUrl);
    const awemeId = videoId || awemeIdFromUrl || '';

    console.log('[VCPBridge] handleDownloadVideo 输入:', {
      requestId,
      version: EXTENSION_RUNTIME_VERSION,
      tabId,
      awemeId: awemeId || '[empty]',
      pageType,
      hasCachedPlayUrl: !!cachedPlayUrl,
      cachedPlayUrlPreview: cachedPlayUrl ? cachedPlayUrl.slice(0, 120) : '',
      sourceUrl: sourceUrl.slice(0, 100),
      contentScriptVersion: msg.content_script_version || ''
    });

    if (!awemeId && !cachedPlayUrl) {
      throw new Error('未识别到视频ID，且没有缓存的播放地址');
    }

    const referer = getDouyinReferer(sourceUrl, awemeId);
    let playUrl = '';
    let playUrlSource = '';
    let aweme = null;

    // 策略1: 使用内容脚本传来的缓存播放地址（来自主世界拦截）
    if (cachedPlayUrl && isLikelyDirectVideoUrl(cachedPlayUrl)) {
      playUrl = cachedPlayUrl;
      playUrlSource = 'cached_play_url_from_content';
      console.log('[VCPBridge] 使用缓存播放地址:', playUrl.slice(0, 120));
    }

    // 策略2: 调用 aweme/detail API（用缓存的签名参数）
    if (!playUrl && awemeId) {
      try {
        aweme = await fetchAwemeDetail(awemeId, referer, { tabId, sourceUrl, requestId });
        playUrl = resolveNoWatermarkPlayUrl(aweme);
        if (playUrl) {
          playUrlSource = 'aweme_detail_api';
          console.log('[VCPBridge] API获取播放地址成功:', playUrl.slice(0, 120));
        }
      } catch (e) {
        console.warn('[VCPBridge] aweme detail API 失败:', e?.message || e);
      }
    }

    if (!playUrl) {
      throw new Error('未获取到可下载的视频地址');
    }

    // 构建文件名
    const resolvedAwemeId = awemeId || `direct_${Date.now()}`;
    const fileName = buildFileName(resolvedAwemeId, aweme, { author_name: authorName, title });
    const savePath = `ChromeBridgeDownloads/${fileName}`;

    console.log('[VCPBridge] 下载解析结果:', {
      requestId, awemeId: resolvedAwemeId, playUrlSource,
      playUrlPreview: playUrl.slice(0, 120), fileName
    });

    // 设置 Referer 规则
    await setDouyinRefererRule(tabId, referer);

    // 决定下载方式
    let downloadUrl = '';
    let shouldRevokeObjectUrl = false;

    console.log('[VCPBridge] 下载 URL 决策:', {
      playUrl: playUrl.slice(0, 150),
      isLikelyDirect: isLikelyDirectVideoUrl(playUrl),
      playUrlLength: playUrl.length
    });

    if (isLikelyDirectVideoUrl(playUrl)) {
      downloadUrl = playUrl;
      console.log('[VCPBridge] 使用直接 URL 下载');
    } else {
      console.log('[VCPBridge] 需要先抓取视频 blob');
      downloadUrl = await fetchDouyinVideoBlobUrl(playUrl, referer, sourceUrl);
      shouldRevokeObjectUrl = true;
    }

    // 验证最终下载 URL
    if (!downloadUrl || !/^(https?|blob):\/\//i.test(downloadUrl)) {
      throw new Error(`下载 URL 无效: ${downloadUrl.slice(0, 100)}`);
    }

    console.log('[VCPBridge] 最终下载 URL:', {
      url: downloadUrl.slice(0, 150),
      protocol: downloadUrl.split(':')[0],
      isBlob: downloadUrl.startsWith('blob:')
    });

    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename: savePath,
        conflictAction: 'uniquify',
        saveAs: false
      });
    } catch (downloadError) {
      console.error('[VCPBridge] chrome.downloads.download 调用失败:', {
        error: downloadError.message,
        downloadUrl: downloadUrl.slice(0, 120),
        savePath
      });
      
      // 检查是否是权限问题
      if (downloadError.message && downloadError.message.includes('permission')) {
        throw new Error('下载权限不足，请在 chrome://extensions/ 检查扩展权限');
      }
      
      // 检查是否是 URL 问题
      if (downloadError.message && (downloadError.message.includes('URL') || downloadError.message.includes('scheme'))) {
        throw new Error(`下载 URL 无效或不支持: ${downloadError.message}`);
      }
      
      throw new Error(`下载失败: ${downloadError.message}`);
    }

    if (!downloadId && downloadId !== 0) {
      throw new Error('浏览器未返回有效的下载任务ID');
    }

    douyinDownloadContextById.set(downloadId, { tabId, sourceUrl, createdAt: Date.now() });
    if (shouldRevokeObjectUrl) {
      douyinBlobUrlByDownloadId.set(downloadId, downloadUrl);
    }

    console.log('[VCPBridge] ✅ 下载任务创建成功:', { requestId, downloadId, savePath });

    sendToServer({
      type: 'download_result',
      data: { requestId, status: 'success', message: '视频下载任务已创建',
        task_id: String(downloadId), file_name: fileName, save_path: savePath, source_url: sourceUrl }
    });

    return { success: true, requestId, task_id: String(downloadId), file_name: fileName, save_path: savePath };
  } catch (e) {
    console.error('[VCPBridge] ❌ 视频下载失败:', { requestId, error: e?.message || e });
    const errorMessage = e.message || '视频下载失败';
    sendToServer({
      type: 'download_result',
      data: { requestId, status: 'error', error: errorMessage }
    });
    if (Number.isInteger(tabId)) await clearDouyinRefererRule(tabId);
    return { success: false, requestId, error: errorMessage };
  }
}

/**
 * 处理来自VCP服务端的下载命令
 */
async function handleDownloadVideoFromServer(requestId, targetUrl) {
  // 服务端命令：先从内容脚本获取 meta，再走统一下载流程
  let tabId;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && Number.isInteger(activeTab.id)) {
      tabId = activeTab.id;
    }
  } catch {}

  const meta = tabId ? await getVideoMetaFromContent(tabId) : {};
  const msg = {
    video_id: meta.video_id || '',
    title: meta.title || '',
    author_name: meta.author_name || '',
    cached_play_url: meta.cached_play_url || '',
    source_url: targetUrl || meta.source_url || '',
    page_type: meta.page_type || ''
  };
  return handleDownloadVideo(requestId, msg);
}

function extractAwemeIdFromUrl(url = '') {
  const matched = String(url || '').match(/\/video\/(\d+)/);
  return matched ? matched[1] : '';
}

async function getVideoMetaFromContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'get_douyin_video_meta' });
    return response?.data || {};
  } catch {
    return {};
  }
}

// ========== aweme detail API ==========

async function parseAwemeDetailResponse(resp) {
  if (!resp.ok) throw new Error(`抖音详情API请求失败: HTTP ${resp.status}`);
  const rawText = await resp.text();
  if (!rawText?.trim()) throw new Error('抖音详情API返回空响应');
  let json;
  try { json = JSON.parse(rawText); } catch (e) {
    throw new Error(`抖音详情API返回非JSON: ${rawText.slice(0, 120)}`);
  }
  if (!json?.aweme_detail) throw new Error('抖音详情API缺少 aweme_detail');
  return json.aweme_detail;
}

async function fetchAwemeDetailWithUrl(apiUrl, referer) {
  const resp = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'referer': referer,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    },
    credentials: 'include'
  });
  return parseAwemeDetailResponse(resp);
}

async function fetchAwemeDetail(awemeId, referer, options = {}) {
  const fallbackUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=1128&version_name=23.5.0&device_platform=android&os_version=2333`;
  const cachedEntry = getLatestDouyinDetailParams();

  // 尝试1: 用缓存的签名参数
  if (cachedEntry?.params?.length) {
    const cachedUrl = buildAwemeDetailUrl(awemeId, cachedEntry);
    try {
      return await fetchAwemeDetailWithUrl(cachedUrl, referer);
    } catch (e) {
      console.warn('[VCPBridge] 缓存参数请求失败:', e?.message);
    }
  }

  // 尝试2: 预热后重试；若主世界已直接拿到 play_url，则直接构造最小 aweme 返回
  if (options?.tabId && awemeId) {
    const prewarmResult = await requestContentScriptPrewarmDetailParams(options.tabId, awemeId, options.sourceUrl || '');
    if (prewarmResult?.play_url) {
      console.log('[VCPBridge] 使用主世界预热直返播放地址:', {
        awemeId,
        playUrlPreview: prewarmResult.play_url.slice(0, 120),
        hasAwemeDetail: !!prewarmResult.has_aweme_detail
      });
      return {
        aweme_id: awemeId,
        desc: prewarmResult.desc || '',
        author: { nickname: prewarmResult.author_name || '' },
        video: {
          play_addr: {
            url_list: [prewarmResult.play_url]
          }
        }
      };
    }

    const refreshed = getLatestDouyinDetailParams();
    if (refreshed?.params?.length) {
      const refreshedUrl = buildAwemeDetailUrl(awemeId, refreshed);
      try {
        return await fetchAwemeDetailWithUrl(refreshedUrl, referer);
      } catch (e) {
        console.warn('[VCPBridge] 预热后请求失败:', e?.message);
      }
    }
  }

  // 尝试3: 回退URL
  return await fetchAwemeDetailWithUrl(fallbackUrl, referer);
}

// ========== 视频资源抓取 ==========

async function fetchDouyinVideoBlobUrl(videoUrl, referer, sourceUrl) {
  const strategies = [
    { label: 'with_credentials', credentials: 'include' },
    { label: 'without_credentials', credentials: undefined }
  ];

  let lastError = '';
  for (const s of strategies) {
    try {
      const resp = await fetch(videoUrl, {
        method: 'GET',
        headers: {
          'accept': 'video/mp4,application/octet-stream;q=0.9,*/*;q=0.8',
          'referer': referer,
          'origin': 'https://www.douyin.com'
        },
        credentials: s.credentials
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('video') && !ct.includes('octet-stream')) {
        throw new Error(`非视频类型: ${ct}`);
      }
      const blob = await resp.blob();
      if (!blob?.size) throw new Error('视频为空');
      console.log('[VCPBridge] 视频抓取成功:', { strategy: s.label, size: blob.size });
      return URL.createObjectURL(blob);
    } catch (e) {
      lastError = `${s.label}: ${e?.message}`;
      console.warn('[VCPBridge] 视频抓取失败:', lastError);
    }
  }
  throw new Error(lastError || '视频资源抓取失败');
}

function resolveNoWatermarkPlayUrl(aweme) {
  if (!aweme?.video) return '';
  const candidates = [
    ...(aweme.video.play_addr?.url_list || []),
    ...(aweme.video.play_addr_h264?.url_list || []),
    ...(aweme.video.play_addr_265?.url_list || []),
    ...(Array.isArray(aweme.video.bit_rate)
      ? [...aweme.video.bit_rate]
          .sort((a, b) => (b?.bit_rate || 0) - (a?.bit_rate || 0))
          .flatMap(item => item?.play_addr?.url_list || [])
      : [])
  ].map(url => normalizeVideoUrl(url)).filter(Boolean);

  return candidates.find(url => isLikelyDirectVideoUrl(url)) || candidates[0] || '';
}

function buildFileName(awemeId, aweme, meta = {}) {
  const author = sanitizeFilePart(meta.author_name) || sanitizeFilePart(aweme?.author?.nickname) || 'douyin_author';
  const title = sanitizeFilePart(meta.title) || sanitizeFilePart(aweme?.desc) || `video_${awemeId}`;
  return `${author}_${title.slice(0, 30)}_${awemeId}.mp4`;
}

function sanitizeFilePart(text = '') {
  return String(text)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

async function cleanupDouyinDownloadContext(downloadId) {
  const ctx = douyinDownloadContextById.get(downloadId);
  const blobUrl = douyinBlobUrlByDownloadId.get(downloadId);

  douyinDownloadContextById.delete(downloadId);
  douyinBlobUrlByDownloadId.delete(downloadId);

  if (blobUrl) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  }

  if (!ctx) return;

  if (Number.isInteger(ctx.tabId)) {
    await clearDouyinRefererRule(ctx.tabId);
  }

  if (ctx.openedTempTab && Number.isInteger(ctx.tabId)) {
    try {
      await chrome.tabs.remove(ctx.tabId);
    } catch {}
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== 'number') return;
  if (!douyinDownloadContextById.has(delta.id)) return;

  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    cleanupDouyinDownloadContext(delta.id).catch((e) => {
      console.warn('[VCPBridge] 清理下载上下文失败:', e);
    });
  }
});

// ========== 右键菜单 ==========

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vcp-feed-selection',
    title: '📤 发送选中文本给VCP',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'vcp-feed-page',
    title: '📤 发送当前页面给VCP',
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'vcp-feed-douyin',
    title: '🐺 投喂旺财（提取抖音数据）',
    contexts: ['page'],
    documentUrlPatterns: ['https://www.douyin.com/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'vcp-feed-selection') {
    sendToServer({
      type: 'feed_data',
      data: {
        extract_type: 'selected_text',
        extractedData: { text: info.selectionText },
        sourceUrl: tab.url
      }
    });
    console.log('[VCPBridge] 📤 已投喂选中文本');
  }

  if (info.menuItemId === 'vcp-feed-page') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extract',
        extractType: 'generic',
        options: {}
      });
      sendToServer({
        type: 'feed_data',
        data: {
          extract_type: 'generic',
          extractedData: response.data,
          sourceUrl: tab.url
        }
      });
      console.log('[VCPBridge] 📤 已投喂页面数据');
    } catch (e) {
      console.error('[VCPBridge] 页面数据投喂失败:', e);
    }
  }

  if (info.menuItemId === 'vcp-feed-douyin') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extract',
        extractType: 'douyin_full',
        options: { comment_count: 50, include_replies: true, sort_by: 'likes' }
      });
      sendToServer({
        type: 'feed_data',
        data: {
          extract_type: 'douyin_full',
          extractedData: response.data,
          sourceUrl: tab.url
        }
      });
      console.log('[VCPBridge] 🐺 已投喂抖音数据');
    } catch (e) {
      console.error('[VCPBridge] 抖音数据投喂失败:', e);
    }
  }
});

// ========== 心跳保活 ==========

setInterval(() => {
  if (isConnected) {
    sendToServer({ type: 'heartbeat', timestamp: Date.now() });
  }
}, 300000); // 5 minutes

// ========== 工具函数 ==========

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 来自popup和content-script的消息 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getConnectionStatus') {
    sendResponse({ connected: isConnected, wsHost, vcpKey: vcpKey ? '已配置' : '未配置' });
    return true;
  }

  if (message.type === 'updateConfig') {
    wsHost = message.host || wsHost;
    vcpKey = message.key || vcpKey;
    chrome.storage.local.set({ vcpWsHost: wsHost, vcpKey: vcpKey });
    if (ws) ws.close();
    connect();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'reconnect') {
    if (ws) ws.close();
    connect();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'pageInfoUpdate') {
    sendToServer({
      type: 'pageInfoUpdate',
      data: { markdown: message.markdown }
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'downloadCurrentVideo') {
    const requestId = `cb-local-download-${Date.now()}`;
    console.log('[VCPBridge] 收到 downloadCurrentVideo 消息:', {
      requestId,
      video_id: message.video_id || '[empty]',
      title: message.title ? message.title.slice(0, 30) : '[empty]',
      author_name: message.author_name || '[empty]',
      has_cached_play_url: !!message.cached_play_url,
      source_url: (message.source_url || '').slice(0, 80),
      content_script_version: message.content_script_version || '[unknown]'
    });
    handleDownloadVideo(requestId, message)
      .then((result) => {
        sendResponse(result || { success: false, requestId, error: '下载任务返回为空' });
      })
      .catch((e) => {
        console.error('[VCPBridge] handleDownloadVideo 异常:', e);
        sendResponse({ success: false, requestId, error: e.message || '视频下载失败' });
      });
    return true;
  }

  if (message.type === 'feedToServer') {
    sendToServer({
      type: 'feed_data',
      data: message.data
    });
    sendResponse({ success: true });
    return true;
  }
});

// ========== 启动 ==========

chrome.webRequest?.onBeforeRequest?.addListener((details) => {
  cacheDouyinDetailParamsFromUrl(details?.url || '', 'webRequest');
}, {
  urls: ['https://www.douyin.com/aweme/v1/web/aweme/detail/*']
});

loadConfig().then(() => {
  connect();
});
