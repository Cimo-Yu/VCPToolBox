// VCPBridge - 创作者平台画像提取 Content Script
// 在 creator.douyin.com / trendinsight.oceanengine.com 上，
// 从主世界画像嗅探缓存中读取受众年龄/性别/地域等分布百分比。
(function () {
    'use strict';

    const PORTRAIT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_CREATOR_PORTRAIT_CACHE_REQUEST';
    const PORTRAIT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_CREATOR_PORTRAIT_CACHE_RESPONSE';
    let portraitSeq = 0;

    function queryPortraitCache(limit = 10) {
        const requestId = `vcp-portrait-${Date.now()}-${++portraitSeq}`;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                resolve(value);
            };
            const onMessage = (event) => {
                const data = event?.data;
                if (!data || data.source !== 'VCPBridge') return;
                if (data.type !== PORTRAIT_CACHE_RESPONSE_EVENT || data.requestId !== requestId) return;
                finish({
                    success: data.success,
                    count: Number(data.count || 0),
                    portraits: Array.isArray(data.portraits) ? data.portraits : []
                });
            };
            window.addEventListener('message', onMessage);
            window.dispatchEvent(new CustomEvent(PORTRAIT_CACHE_REQUEST_EVENT, {
                detail: { requestId, limit }
            }));
            setTimeout(() => finish({ success: false, count: 0, portraits: [] }), 350);
        });
    }

    function summarizePage() {
        return {
            title: document.title,
            url: window.location.href,
            domain: window.location.hostname
        };
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'extract' &&
            (message.extractType === 'douyin_audience_portrait' || message.extractType === 'creator_portrait')) {
            const limit = Number(message.options?.portrait_count) || 10;
            queryPortraitCache(limit).then((cache) => {
                sendResponse({
                    data: {
                        type: 'audience_portrait',
                        page: summarizePage(),
                        portrait_count: cache.count,
                        portraits: cache.portraits,
                        hint: '画像数据来自创作者服务平台/巨量算数 API 拦截；需在扩展浏览器中登录并打开对应数据页（作品分析/粉丝画像等）'
                    }
                });
            }).catch((e) => {
                sendResponse({ data: { error: e.message || '画像提取失败' } });
            });
            return true;
        }
        return false;
    });
})();
