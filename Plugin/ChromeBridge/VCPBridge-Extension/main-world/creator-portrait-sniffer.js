// VCPBridge - 创作者平台画像嗅探 Main World
// 拦截 creator.douyin.com / trendinsight.oceanengine.com 的 API JSON 响应，
// 扫描年龄/性别/地域/兴趣等分布结构并缓存，供内容脚本提取受众画像。
(() => {
    'use strict';

    const PORTRAIT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_CREATOR_PORTRAIT_CACHE_REQUEST';
    const PORTRAIT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_CREATOR_PORTRAIT_CACHE_RESPONSE';
    const MAX_PORTRAITS = 30;
    const portraitCache = [];

    function safeJsonParse(text) {
        try { return JSON.parse(text); } catch { return null; }
    }

    // 分布结构：数组元素形如 { name/label + value/percent/ratio/count }
    function looksLikeDistribution(value) {
        if (!Array.isArray(value) || value.length === 0 || value.length > 200) return false;
        const sample = value[0];
        if (!sample || typeof sample !== 'object') return false;
        const keys = Object.keys(sample);
        const hasName = keys.some(k => /name|label|type|key|term|item|title/i.test(k));
        const hasValue = keys.some(k => /value|percent|ratio|count|num|number|pct|index/i.test(k));
        return hasName && hasValue;
    }

    const DISTRIBUTION_KEY_RE = /age|gender|region|city|province|province_name|city_name|interest|device|follower|fan|audience|portrait|term|zodiac|constellation|user_level/i;

    function scanDistributions(value, path = '', out = []) {
        if (!value || typeof value !== 'object') return out;
        if (Array.isArray(value)) {
            for (const item of value) scanDistributions(item, path, out);
            return out;
        }
        for (const [k, v] of Object.entries(value)) {
            const p = path ? `${path}.${k}` : k;
            if (looksLikeDistribution(v) && DISTRIBUTION_KEY_RE.test(k)) {
                out.push({ path: p, label: k, data: v });
            }
            if (v && typeof v === 'object') {
                // 避免深挖大数组，只递归对象与小数组
                if (Array.isArray(v) && v.length > 50) continue;
                scanDistributions(v, p, out);
            }
        }
        return out;
    }

    function getPathname(url) {
        try { return new URL(url).pathname; } catch { return ''; }
    }

    function handlePayload(url, payload) {
        if (!payload || typeof payload !== 'object') return;
        try {
            const found = scanDistributions(payload);
            if (found.length) {
                portraitCache.push({
                    url: String(url || '').slice(0, 300),
                    pathname: getPathname(url),
                    captured_at: new Date().toISOString(),
                    portraits: found.slice(0, 6)
                });
                if (portraitCache.length > MAX_PORTRAITS) portraitCache.shift();
            }
        } catch (_) { /* ignore */ }
    }

    function isLikelyJsonApi(url) {
        return /\/api\/|json/i.test(String(url || ''));
    }

    // —— fetch 拦截 ——
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const requestUrl = typeof args?.[0] === 'string' ? args[0] : args?.[0]?.url || '';
            const absUrl = new URL(requestUrl, window.location.origin).href;
            if (response.ok && isLikelyJsonApi(absUrl)) {
                response.clone().text().then((text) => {
                    const payload = safeJsonParse(text);
                    if (payload) handlePayload(absUrl, payload);
                }).catch(() => {});
            }
        } catch (_) { /* ignore */ }
        return response;
    };

    // —— XHR 拦截 ——
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__vcpPortraitUrl = url;
        return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener?.('load', () => {
            try {
                const absUrl = new URL(this.__vcpPortraitUrl || '', window.location.origin).href;
                if (this.status >= 200 && this.status < 300 && isLikelyJsonApi(absUrl)) {
                    const payload = safeJsonParse(this.responseText);
                    if (payload) handlePayload(absUrl, payload);
                }
            } catch (_) { /* ignore */ }
        });
        return originalSend.apply(this, args);
    };

    // —— 画像缓存查询 ——
    window.addEventListener(PORTRAIT_CACHE_REQUEST_EVENT, (event) => {
        const detail = event?.detail || {};
        const requestId = detail.requestId || '';
        const limit = Number(detail.limit) || 10;
        const recent = portraitCache.slice(-limit);
        window.postMessage({
            source: 'VCPBridge',
            type: PORTRAIT_CACHE_RESPONSE_EVENT,
            requestId,
            success: recent.length > 0,
            count: recent.length,
            portraits: recent.map((p) => ({
                pathname: p.pathname,
                captured_at: p.captured_at,
                portraits: p.portraits
            }))
        }, window.location.origin);
    }, false);

    console.log('[VCPBridge][MAIN] 创作者平台画像嗅探已加载');
})();
