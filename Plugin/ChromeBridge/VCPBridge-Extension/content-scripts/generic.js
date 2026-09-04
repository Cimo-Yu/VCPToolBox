// VCPBridge - 通用页面 Content Script
// 提供基础的页面信息提取和DOM交互能力

(function() {
    'use strict';

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // 通用数据提取
        if (message.type === 'extract' && message.extractType === 'generic') {
            const data = extractGenericPageData();
            sendResponse({ data });
            return true;
        }

        // 获取页面信息（Markdown格式，兼容原ChromeObserver）
        if (message.type === 'getPageInfo') {
            const markdown = getPageInfoMarkdown();
            sendResponse({ markdown });
            return true;
        }

        // 点击元素
        if (message.type === 'click') {
            try {
                const result = clickElement(message.target);
                sendResponse({ message: result });
            } catch (e) {
                sendResponse({ error: e.message });
            }
            return true;
        }

        // 输入文本
        if (message.type === 'type') {
            try {
                const result = typeInElement(message.target, message.text);
                sendResponse({ message: result });
            } catch (e) {
                sendResponse({ error: e.message });
            }
            return true;
        }
    });

    // 通用页面数据提取
    function extractGenericPageData() {
        return {
            type: 'generic_page',
            title: document.title,
            url: window.location.href,
            meta_description: document.querySelector('meta[name="description"]')?.content || '',
            h1: [...document.querySelectorAll('h1')].map(el => el.textContent.trim()).slice(0, 5),
            h2: [...document.querySelectorAll('h2')].map(el => el.textContent.trim()).slice(0, 10),
            main_text: getMainText(),
            links: getImportantLinks(),
            extracted_at: new Date().toISOString()
        };
    }

    // 获取页面主要文本内容
    function getMainText() {
        const selectors = ['article', 'main', '[role="main"]', '.content', '.post-content', '.article-content', '#content'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 100) {
                return el.textContent.trim().substring(0, 5000);
            }
        }
        // 降级：取body文本
        return document.body.innerText.substring(0, 3000);
    }

    // 获取重要链接
    function getImportantLinks() {
        const links = [];
        document.querySelectorAll('a[href]').forEach(a => {
            const text = a.textContent.trim();
            if (text && text.length > 2 && text.length < 100 && a.href.startsWith('http')) {
                links.push({ text, href: a.href });
            }
        });
        return links.slice(0, 30);
    }

    // 获取页面信息（Markdown格式）
    function getPageInfoMarkdown() {
        let md = `# ${document.title}\nURL: ${window.location.href}\n\n`;

        // 输入框
        document.querySelectorAll('input, textarea').forEach((el, i) => {
            const label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || `输入框${i+1}`;
            md += `[输入框: ${label}](vcp-id-${i})\n`;
        });

        // 按钮
        document.querySelectorAll('button, [role="button"], a[href]').forEach((el, i) => {
            const text = el.textContent.trim().substring(0, 50);
            if (text) {
                md += `[按钮: ${text}](vcp-btn-${i})\n`;
            }
        });

        return md.substring(0, 4000);
    }

    // 点击元素
    function clickElement(target) {
        const el = findElement(target);
        if (!el) throw new Error(`未找到元素: ${target}`);
        el.click();
        return `已点击: ${target}`;
    }

    // 输入文本
    function typeInElement(target, text) {
        const el = findElement(target);
        if (!el) throw new Error(`未找到输入框: ${target}`);
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return `已输入文本到: ${target}`;
    }

    // 查找元素（按文本、placeholder、aria-label等）
    function findElement(target) {
        // CSS.escape 防止选择器注入（如 target 含引号、括号等特殊字符）
        const safeTarget = CSS.escape ? CSS.escape(target) : target.replace(/([^\w-])/g, '\\$1');
        // 精确匹配
        let el = document.querySelector(`[placeholder="${safeTarget}"], [aria-label="${safeTarget}"], [name="${safeTarget}"]`);
        if (el) return el;

        // 文本匹配
        const allEls = document.querySelectorAll('button, a, input, textarea, [role="button"]');
        for (const candidate of allEls) {
            if (candidate.textContent.trim().includes(target) ||
                candidate.getAttribute('placeholder')?.includes(target) ||
                candidate.getAttribute('aria-label')?.includes(target)) {
                return candidate;
            }
        }
        return null;
    }

    console.log('[VCPBridge] 📄 通用页面提取器已加载');

    // 页面加载时通知后台，唤醒可能休眠的 Service Worker（MV3 保活）
    try {
        chrome.runtime.sendMessage({ type: 'content_ready' });
    } catch (e) {
        // 忽略：SW 唤醒失败不影响页面功能
    }
})();
