// VCPBridge - 抖音专用 Content Script
// 负责从抖音页面提取结构化数据 + 悬浮球下载
// v1.6.1 - 评论预热：主动调用评论 API 填充缓存

(function() {
    'use strict';

    const CONTENT_SCRIPT_VERSION = '1.6.1';
    const CONTENT_SCRIPT_BOOT_TS = new Date().toISOString();

    // ========== 主世界通信事件名 ==========
    const MAIN_WORLD_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_CACHE_REQUEST';
    const MAIN_WORLD_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_CACHE_RESPONSE';
    const MAIN_WORLD_COMMENT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_CACHE_REQUEST';
    const MAIN_WORLD_COMMENT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_CACHE_RESPONSE';
    const MAIN_WORLD_COMMENT_PREWARM_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_PREWARM_REQUEST';
    const MAIN_WORLD_COMMENT_PREWARM_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_PREWARM_RESPONSE';
    let mainWorldRequestSeq = 0;

    // ========== 来自Background的消息监听 ==========
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'extract') {
            const { extractType, options } = message;

            if (extractType === 'douyin_video') {
                extractVideoInfo().then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_comments') {
                extractComments(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_author') {
                extractAuthorInfo().then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_likes') {
                extractProfileList('like').then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_collects') {
                extractProfileList('collect').then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_posts') {
                extractProfileList('post', { maxRounds: 12 }).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_search') {
                extractSearchResults(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_feed') {
                extractFeedVideos(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_hot') {
                extractHotBoard().then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_live_danmaku') {
                extractLiveDanmaku(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_captions') {
                extractVideoCaptions(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_full') {
                extractFullData(options).then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }

            if (extractType === 'douyin_note') {
                extractNoteInfo().then(data => sendResponse({ data })).catch(e => sendResponse({ data: { error: e.message } }));
                return true;
            }
        }

        if (message.type === 'get_douyin_video_meta') {
            getDouyinVideoMeta()
                .then((meta) => sendResponse({ data: meta }))
                .catch((e) => sendResponse({ data: { error: e.message || '获取视频元信息失败' } }));
            return true;
        }

        if (message.type === 'feed_douyin_video') {
            feedCurrentVideoToServer().then((result) => {
                sendResponse({ success: true, ...result });
            }).catch((e) => {
                sendResponse({ success: false, error: e.message });
            });
            return true;
        }

        // 后台请求内容脚本触发下载（已废弃，现在由内容脚本主动发起）
        if (message.type === 'download_douyin_video') {
            doDownloadFlow()
                .then((result) => sendResponse(result))
                .catch((e) => sendResponse({ success: false, error: e.message || '下载失败' }));
            return true;
        }

        if (message.type === 'prewarm_douyin_aweme_detail') {
            const awemeId = String(message.awemeId || '').trim();
            const sourceUrl = String(message.sourceUrl || window.location.href || '').trim();
            prewarmAwemeDetailInMainWorld(awemeId, sourceUrl)
                .then((result) => sendResponse({ success: true, ...result }))
                .catch((e) => sendResponse({ success: false, error: e.message || '页面预热失败' }));
            return true;
        }
    });

    // ========== 视频信息提取 ==========

    async function extractVideoInfo() {
        const info = {};

        const descEl = document.querySelector('[data-e2e="video-desc"]') ||
                       document.querySelector('.video-info-detail .title') ||
                       document.querySelector('.SEOTitle') ||
                       document.querySelector('[class*="title"][class*="video"]') ||
                       document.querySelector('[class*="desc"][class*="video"]') ||
                       document.querySelector('h1');
        info.title = descEl ? descEl.textContent.trim() : document.title;

        const tagEls = document.querySelectorAll('[data-e2e="video-desc"] a, .video-info-detail a[href*="hashtag"], a[href*="/hashtag/"], a[class*="hashtag"]');
        info.tags = [...tagEls].map(el => el.textContent.trim()).filter(t => t.startsWith('#'));

        // 点赞/收藏/评论/分享计数 — 增强选择器匹配
        const likeEl = document.querySelector('[data-e2e="digg-count"]') ||
                       document.querySelector('.like-count') ||
                       document.querySelector('[class*="likeCount"]') ||
                       document.querySelector('[class*="digg-count"]');
        info.likes = likeEl ? likeEl.textContent.trim() : '未知';

        const commentCountEl = document.querySelector('[data-e2e="comment-count"]') ||
                               document.querySelector('.comment-count') ||
                               document.querySelector('[class*="commentCount"]');
        info.comment_count = commentCountEl ? commentCountEl.textContent.trim() : '未知';

        const collectEl = document.querySelector('[data-e2e="collect-count"]') ||
                          document.querySelector('.collect-count') ||
                          document.querySelector('[class*="collectCount"]') ||
                          document.querySelector('[class*="favoriteCount"]');
        info.collects = collectEl ? collectEl.textContent.trim() : '未知';

        const shareEl = document.querySelector('[data-e2e="share-count"]') ||
                        document.querySelector('.share-count') ||
                        document.querySelector('[class*="shareCount"]');
        info.shares = shareEl ? shareEl.textContent.trim() : '未知';

        // 作者信息增强提取
        const authorEl = document.querySelector('[data-e2e="video-author-info"]') ||
                         document.querySelector('.author-info') ||
                         document.querySelector('.video-info-detail .author') ||
                         document.querySelector('[class*="authorInfo"]') ||
                         document.querySelector('[class*="author-info"]');
        info.author = {};
        if (authorEl) {
            const nameEl = authorEl.querySelector('.name, .nickname, a, [class*="nickname"], [class*="userName"]');
            info.author.name = nameEl ? nameEl.textContent.trim() : '未知';
            const linkEl = authorEl.querySelector('a[href*="/user/"]');
            info.author.profile_url = linkEl ? linkEl.href : '';
        } else {
            // 兜底：在侧边栏或视频区域找作者名
            const fallbackAuthor = document.querySelector('[data-e2e="browser-nickname"] span:first-child') ||
                                   document.querySelector('[class*="nickname"]') ||
                                   document.querySelector('[class*="authorName"]');
            if (fallbackAuthor) {
                info.author.name = fallbackAuthor.textContent.trim();
            }
        }

        const bgmEl = document.querySelector('[data-e2e="video-music"]') ||
                      document.querySelector('.music-info') ||
                      document.querySelector('[class*="musicInfo"]') ||
                      document.querySelector('[class*="music-name"]');
        info.bgm = bgmEl ? bgmEl.textContent.trim() : '未知';

        const timeEl = document.querySelector('[data-e2e="browser-nickname"] span.time') ||
                       document.querySelector('.video-publish-time') ||
                       document.querySelector('time') ||
                       document.querySelector('[class*="publishTime"]');
        info.publish_time = timeEl ? timeEl.textContent.trim() : '未知';

        info.url = window.location.href;

        return { type: 'video_info', ...info };
    }

    // ========== 评论区提取 ==========

    // 评论列表项选择器组（抖音前端改版适配，多策略匹配）
    const COMMENT_ITEM_SELECTORS = [
        '[data-e2e="comment-list-item"]',
        '.comment-item',
        '.comment-list > div[class*="comment"]',
        // 新版抖音可能使用的结构
        '[class*="CommentListContainer"] > div[class*="CommentItem"]',
        '[class*="commentListContainer"] > div[class*="commentItem"]',
        // 通用回退：评论面板内的直接子 div（最后手段）
        '[class*="comment"] > div > div[class*="container"]'
    ].join(', ');

    // 评论容器选择器组
    const COMMENT_CONTAINER_SELECTORS = [
        '[data-e2e="comment-list"]',
        '.comment-list',
        '.comment-mainContent',
        '[class*="CommentListContainer"]',
        '[class*="commentListContainer"]',
        // 新版抖音评论面板
        '[class*="comment-panel"] [class*="list"]',
        '[class*="commentPanel"] [class*="list"]'
    ].join(', ');

    async function extractComments(options = {}) {
        const maxCount = options.comment_count || 50;
        const includeReplies = options.include_replies !== false;
        const comments = [];

        await scrollToLoadComments(maxCount);

        let commentEls = document.querySelectorAll(COMMENT_ITEM_SELECTORS);

        // 兜底策略：如果精确选择器都匹配不到，尝试基于文本内容的启发式提取
        if (commentEls.length === 0) {
            console.log('[VCPBridge] DOM 精确选择器未匹配评论，尝试启发式策略...');
            commentEls = findCommentElementsHeuristically();
        }

        for (const el of commentEls) {
            if (comments.length >= maxCount) break;

            const comment = {};

            const userEl = el.querySelector('[data-e2e="comment-username"], .user-name, .comment-user a, a[class*="userName"], a[class*="nickname"], a[class*="author"]');
            comment.user = userEl ? userEl.textContent.trim() : '匿名';

            const contentEl = el.querySelector('[data-e2e="comment-text"], .comment-content, .comment-text, p[class*="commentText"], span[class*="commentContent"], [class*="content"]');
            comment.text = contentEl ? contentEl.textContent.trim() : '';

            const likeEl = el.querySelector('[data-e2e="comment-digg-count"], .comment-like-count, span[class*="likeCount"], span[class*="diggCount"]');
            comment.likes = likeEl ? likeEl.textContent.trim() : '0';

            const timeEl = el.querySelector('.comment-time, time, [data-e2e="comment-time"], span[class*="time"], span[class*="Time"]');
            comment.time = timeEl ? timeEl.textContent.trim() : '';

            if (includeReplies) {
                const replyEls = el.querySelectorAll('.reply-item, [data-e2e="comment-reply-item"], [class*="replyItem"], [class*="ReplyItem"]');
                comment.replies = [];
                for (const replyEl of replyEls) {
                    const replyUser = replyEl.querySelector('.user-name, a[class*="userName"], a[class*="nickname"], a')?.textContent?.trim() || '匿名';
                    const replyText = replyEl.querySelector('.comment-content, .reply-content, [class*="content"], p, span')?.textContent?.trim() || '';
                    const replyLikes = replyEl.querySelector('.comment-like-count, [data-e2e="comment-digg-count"], span[class*="likeCount"]')?.textContent?.trim() || '0';
                    if (replyText) {
                        comment.replies.push({ user: replyUser, text: replyText, likes: replyLikes });
                    }
                }
            }

            if (comment.text) {
                comments.push(comment);
            }
        }

        return {
            type: 'comments',
            total_extracted: comments.length,
            comments,
            source_url: window.location.href
        };
    }

    /**
     * 启发式评论元素发现：当精确选择器失效时，通过DOM结构模式匹配查找评论
     * 策略：找到评论面板容器，枚举其子元素，判断是否"看起来像评论"
     */
    function findCommentElementsHeuristically() {
        // 评论面板通常在页面右侧或底部的固定容器中
        const panels = document.querySelectorAll(
            '[class*="comment"], [class*="Comment"], [data-e2e*="comment"]'
        );
        
        for (const panel of panels) {
            // 找到具有多个同级子元素的容器（评论列表特征：重复结构）
            const children = panel.children;
            if (children.length >= 3) {
                // 检查是否有足够多的子元素看起来像评论（包含用户名链接和文本内容）
                let commentLikeCount = 0;
                for (const child of children) {
                    const hasUserLink = child.querySelector('a[href*="/user/"], a[class*="user"], a[class*="User"], a[class*="name"]');
                    const hasText = child.textContent.trim().length > 5;
                    if (hasUserLink && hasText) commentLikeCount++;
                }
                if (commentLikeCount >= 2) {
                    console.log('[VCPBridge] 启发式策略找到评论容器:', {
                        panelClass: panel.className?.slice?.(0, 60),
                        childCount: children.length,
                        commentLikeCount
                    });
                    return Array.from(children).filter(child => {
                        const hasUserLink = child.querySelector('a[href*="/user/"], a[class*="user"], a[class*="User"], a[class*="name"]');
                        return hasUserLink && child.textContent.trim().length > 5;
                    });
                }
            }
        }
        
        console.warn('[VCPBridge] 启发式策略也未找到评论元素');
        return [];
    }

    async function scrollToLoadComments(targetCount) {
        const commentSection = document.querySelector(COMMENT_CONTAINER_SELECTORS);
        if (!commentSection) {
            console.log('[VCPBridge] 未找到评论容器，跳过滚动加载');
            return;
        }

        let lastCount = 0;
        let sameCountTimes = 0;
        const maxScrollAttempts = 20;

        for (let i = 0; i < maxScrollAttempts; i++) {
            const currentComments = document.querySelectorAll(COMMENT_ITEM_SELECTORS);

            if (currentComments.length >= targetCount) break;

            if (currentComments.length === lastCount) {
                sameCountTimes++;
                if (sameCountTimes >= 3) break;
            } else {
                sameCountTimes = 0;
            }
            lastCount = currentComments.length;

            commentSection.scrollTop = commentSection.scrollHeight;
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // ========== 作者主页提取 ==========

    async function extractAuthorInfo() {
        const info = {};

        const nameEl = document.querySelector('[data-e2e="user-info-nickname"], .user-info .nickname, h1');
        info.name = nameEl ? nameEl.textContent.trim() : '未知';

        const bioEl = document.querySelector('[data-e2e="user-info-desc"], .user-info .desc, .user-desc');
        info.bio = bioEl ? bioEl.textContent.trim() : '';

        const countEls = document.querySelectorAll('[data-e2e="user-info-count"], .user-info .count, .user-count span');
        const counts = [...countEls].map(el => el.textContent.trim());
        info.following = counts[0] || '未知';
        info.followers = counts[1] || '未知';
        info.total_likes = counts[2] || '未知';

        const videoEls = document.querySelectorAll('[data-e2e="user-post-list"] > div, .user-post-list .video-card');
        info.recent_posts = [];
        for (const videoEl of [...videoEls].slice(0, 20)) {
            const titleEl = videoEl.querySelector('a, .title, .video-title');
            const viewEl = videoEl.querySelector('.play-count, .view-count');
            const linkEl = videoEl.querySelector('a[href*="/video/"], a[href*="/note/"]')
                        || videoEl.querySelector('a[href]');
            const href = linkEl ? linkEl.href : '';
            const idMatch = href.match(/\/(video|note)\/(\d+)/);
            if (titleEl) {
                info.recent_posts.push({
                    title: titleEl.textContent.trim().substring(0, 100),
                    views: viewEl ? viewEl.textContent.trim() : '未知',
                    url: href,
                    content_id: idMatch ? idMatch[2] : '',
                    content_type: idMatch ? idMatch[1] : 'unknown'
                });
            }
        }
        info.recent_videos = info.recent_posts; // 向后兼容

        info.profile_url = window.location.href;

        return { type: 'author_info', ...info };
    }

    // ========== 个人主页列表提取（喜欢 / 收藏 / 作品） ==========

    async function extractProfileList(requestedTab, options = {}) {
        const info = {};

        // 页头信息（复用作者主页选择器）
        const nameEl = document.querySelector('[data-e2e="user-info-nickname"], .user-info .nickname, h1');
        info.name = nameEl ? nameEl.textContent.trim() : '未知';

        const countEls = document.querySelectorAll('[data-e2e="user-info-count"], .user-info .count, .user-count span');
        const counts = [...countEls].map(el => el.textContent.trim());
        info.following = counts[0] || '未知';
        info.followers = counts[1] || '未知';
        info.total_likes = counts[2] || '未知';

        // 当前激活的 Tab（从 URL showTab 参数识别）
        const currentUrl = window.location.href;
        const showTabMatch = currentUrl.match(/[?&]showTab=([^&#]+)/);
        let activeTab = showTabMatch ? decodeURIComponent(showTabMatch[1]).toLowerCase() : '';
        if (!activeTab && currentUrl.includes('/user/')) activeTab = 'post';
        if (activeTab === 'fav_collection' || activeTab === 'fav') activeTab = 'collect';
        info.active_tab = activeTab;
        info.requested_tab = requestedTab;
        info.profile_url = currentUrl;

        // 列表容器选择器（作品/喜欢/收藏/合集，兼容站点多个版本）
        const listSelectors = [
            '[data-e2e="user-post-list"] > div',
            '[data-e2e="user-like-list"] > div',
            '[data-e2e="user-fav-list"] > div',
            '[data-e2e="user-collect-list"] > div',
            '[data-e2e="user-collection-list"] > div',
            '[data-e2e="like-list"] > div',
            '[data-e2e="collect-list"] > div',
            '.user-post-list .video-card',
            '[class*="post-list"] > div',
            '[class*="like-list"] > div',
            '[class*="collect-list"] > div',
            '[class*="collection-list"] > div'
        ];

        const seen = new Map(); // content_id -> item
        const MAX_SCROLL_ROUNDS = Number(options.maxRounds) > 0 ? Number(options.maxRounds) : 5;
        let rounds = 0;

        while (rounds < MAX_SCROLL_ROUNDS) {
            let items = [];
            for (const selector of listSelectors) {
                items = items.concat(Array.from(document.querySelectorAll(selector)));
            }
            if (items.length === 0 && rounds === 0) {
                // 兜底：整个页面里匹配视频/图文/合集链接
                items = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="/collection/"]'));
            }

            for (const el of items) {
                const isAnchor = el.matches && el.matches('a');
                const linkEl = isAnchor
                    ? el
                    : el.querySelector('a[href*="/video/"], a[href*="/note/"], a[href*="/collection/"], a[href]');
                const href = linkEl ? linkEl.href : '';
                const idMatch = href.match(/\/(video|note|collection)\/(\d+)/);
                if (!idMatch) continue;

                const contentId = idMatch[2];
                if (seen.has(contentId)) continue;

                const titleEl = isAnchor
                    ? el
                    : el.querySelector('a, .title, .video-title, [class*="title"]');
                const viewEl = el.querySelector('.play-count, .view-count, [class*="count"]');
                seen.set(contentId, {
                    title: titleEl ? titleEl.textContent.trim().substring(0, 120) : '',
                    views: viewEl ? viewEl.textContent.trim() : '未知',
                    url: href,
                    content_id: contentId,
                    content_type: idMatch[1]
                });
            }

            // 滚动加载更多（列表容器 + 窗口双保险）
            const listContainer = document.querySelector(
                '[data-e2e="user-post-list"], [data-e2e="user-like-list"], [data-e2e="user-fav-list"], ' +
                '[data-e2e="user-collect-list"], [data-e2e="user-collection-list"], ' +
                '[class*="post-list"], [class*="like-list"], [class*="collect-list"]'
            );
            if (listContainer) listContainer.scrollTop = listContainer.scrollHeight;
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            await new Promise(r => setTimeout(r, 800));
            rounds++;
        }

        info.items = Array.from(seen.values());
        info.item_count = info.items.length;
        info.scroll_rounds = rounds;

        // 提示信息
        const warnings = [];
        if (requestedTab === 'like' && activeTab !== 'like') warnings.push('当前页面不在"喜欢"Tab，请使用 ?showTab=like 的链接');
        if (requestedTab === 'collect' && activeTab !== 'collect') warnings.push('当前页面不在"收藏"Tab，请使用 ?showTab=collect 的链接');
        if (info.item_count === 0) warnings.push('未提取到列表项：可能需要登录、列表为空，或页面仍在加载中');
        if (warnings.length) info.warnings = warnings;

        return { type: `profile_list_${requestedTab}`, ...info };
    }

    // ========== 关键词搜索提取（综合 / 视频 / 用户） ==========

    async function extractSearchResults(options = {}) {
        const info = {};
        const currentUrl = window.location.href;
        let urlObj;
        try {
            urlObj = new URL(currentUrl);
        } catch {
            urlObj = null;
        }
        const searchType = String(options.search_type || urlObj?.searchParams.get('type') || 'general').trim().toLowerCase();
        const keyword = String(options.keyword || urlObj?.searchParams.get('keyword') || '').trim()
                        || document.title.replace(/_抖音搜索.*$/, '').replace(/^.*?_/, '');

        info.keyword = keyword;
        info.search_type = searchType;
        info.url = currentUrl;

        const seen = new Map(); // 视频按 content_id、用户按 u:sec_uid
        const MAX_SCROLL_ROUNDS = 4;
        let rounds = 0;

        const videoCardSelectors = [
            '[data-e2e="search-card-video"]',
            '[data-e2e="search-card"]',
            '.search-result-card',
            '[class*="search-result"] [class*="video"]',
            '[class*="video-search-card"]'
        ];
        const userCardSelectors = [
            '[data-e2e="search-card-user"]',
            '[data-e2e="search-card"] [class*="user"]',
            '[class*="user-search-card"]',
            '[class*="search-user"]'
        ];

        while (rounds < MAX_SCROLL_ROUNDS) {
            // —— 视频 / 图文结果 ——
            let videoCards = [];
            for (const selector of videoCardSelectors) {
                videoCards = videoCards.concat(Array.from(document.querySelectorAll(selector)));
            }
            if (videoCards.length === 0 && rounds === 0) {
                videoCards = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'));
            }

            for (const card of videoCards) {
                const isAnchor = card.matches && card.matches('a[href*="/video/"], a[href*="/note/"]');
                const linkEl = isAnchor
                    ? card
                    : card.querySelector('a[href*="/video/"], a[href*="/note/"]');
                const href = linkEl ? linkEl.href : '';
                const idMatch = href.match(/\/(video|note)\/(\d+)/);
                if (!idMatch) continue;

                const contentId = idMatch[2];
                if (seen.has(contentId)) continue;

                const titleEl = isAnchor ? card : card.querySelector('[class*="title"], .title, [data-e2e="video-title"]');
                const authorEl = card.querySelector('[class*="author"], [class*="nickname"], [data-e2e="search-card-user"]');
                const statEl = card.querySelector('[class*="count"], .play-count, .like-count, [class*="play"]');

                const item = {
                    title: titleEl ? titleEl.textContent.trim().substring(0, 120) : '',
                    author: authorEl ? authorEl.textContent.trim().substring(0, 60) : '',
                    stats: statEl ? statEl.textContent.trim() : '',
                    url: href,
                    content_id: contentId,
                    content_type: idMatch[1]
                };

                // 用主世界拦截到的 API 缓存补全精确数据（best-effort）
                try {
                    const cached = await queryCachedAwemeFromMainWorld(contentId);
                    if (cached) {
                        item.desc = cached.desc;
                        item.statistics = cached.statistics;
                        item.play_url = cached.play_url;
                    }
                } catch (_) { /* 缓存查询失败不影响 DOM 结果 */ }

                seen.set(contentId, item);
            }

            // —— 用户结果（search_type=user） ——
            if (searchType === 'user' || searchType === 'general') {
                let userCards = [];
                for (const selector of userCardSelectors) {
                    userCards = userCards.concat(Array.from(document.querySelectorAll(selector)));
                }
                for (const card of userCards) {
                    const linkEl = card.querySelector('a[href*="/user/"]') || (card.matches && card.matches('a[href*="/user/"]') ? card : null);
                    const href = linkEl ? linkEl.href : '';
                    const idMatch = href.match(/\/user\/([^?/#]+)/);
                    if (!idMatch) continue;
                    const secUid = decodeURIComponent(idMatch[1]);
                    const key = 'u:' + secUid;
                    if (seen.has(key)) continue;

                    const nickEl = card.querySelector('[class*="nickname"], [class*="name"]');
                    const sigEl = card.querySelector('[class*="signature"], [class*="desc"], [class*="bio"]');
                    const followerEl = card.querySelector('[class*="follower"], [class*="count"]');
                    seen.set(key, {
                        nickname: nickEl ? nickEl.textContent.trim().substring(0, 60) : '',
                        signature: sigEl ? sigEl.textContent.trim().substring(0, 200) : '',
                        followers: followerEl ? followerEl.textContent.trim() : '',
                        url: href,
                        sec_uid: secUid,
                        content_type: 'user'
                    });
                }
            }

            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            await new Promise(r => setTimeout(r, 800));
            rounds++;
        }

        const allItems = Array.from(seen.values());
        info.videos = allItems.filter(i => i.content_type !== 'user');
        info.users = allItems.filter(i => i.content_type === 'user');
        info.total_count = allItems.length;

        if (info.total_count === 0) {
            info.warnings = ['未提取到搜索结果：可能未登录、无匹配结果，或页面仍在加载中'];
        }

        return { type: 'search_results', ...info };
    }

    // ========== 推荐流爆款视频收集（结构化清洗） ==========

    async function extractFeedVideos(options = {}) {
        const info = {};
        info.url = window.location.href;
        info.page_type = detectDouyinPageType();

        const seen = new Map(); // content_id -> item
        const MAX_SCROLL_ROUNDS = Number(options.maxRounds) > 0 ? Number(options.maxRounds) : 8;
        const MAX_ITEMS = Number(options.maxItems) > 0 ? Number(options.maxItems) : 30;
        let rounds = 0;

        while (rounds < MAX_SCROLL_ROUNDS && seen.size < MAX_ITEMS) {
            const cardEls = Array.from(document.querySelectorAll(
                'video, [data-e2e-vid], [data-e2e="feed-video"], [data-e2e="feed-card"], [class*="feed-item"], [class*="feed-card"]'
            ));
            for (const el of cardEls) {
                const extracted = extractAwemeIdFromElementContext(el);
                if (!extracted.id || seen.has(extracted.id)) continue;

                let cached = null;
                try {
                    cached = await queryCachedAwemeFromMainWorld(extracted.id);
                } catch (_) { /* 忽略缓存查询失败 */ }

                const descEl = el.querySelector('[data-e2e="video-desc"], .video-info-detail, [class*="desc"]');
                seen.set(extracted.id, {
                    content_id: extracted.id,
                    desc: cached?.desc || (descEl ? descEl.textContent.trim().substring(0, 200) : ''),
                    author: cached?.author_name || '',
                    statistics: cached?.statistics || null,
                    play_url: cached?.play_url || '',
                    share_url: cached?.share_url || '',
                    duration: cached?.duration || 0,
                    create_time: cached?.create_time || 0,
                    url: `https://www.douyin.com/video/${extracted.id}`,
                    id_source: extracted.source
                });
            }

            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            await new Promise(r => setTimeout(r, 900));
            rounds++;
        }

        info.items = Array.from(seen.values());
        info.item_count = info.items.length;
        info.scroll_rounds = rounds;
        if (info.item_count === 0) {
            info.warnings = ['未提取到推荐流视频：可能未登录、页面未加载，或当前不在推荐流页面'];
        }

        return { type: 'feed_videos', ...info };
    }

    // ========== 热搜榜提取（爆款话题结构化） ==========

    async function extractHotBoard() {
        const info = {};
        info.url = window.location.href;

        const items = [];
        const seen = new Set();
        // 以话题链接为准（a[href*="/hot/"]），再向上找包含排名/热度的容器
        const anchors = Array.from(document.querySelectorAll('a[href*="/hot/"]'));
        for (const linkEl of anchors) {
            const title = (linkEl.innerText || linkEl.textContent || '').trim().substring(0, 100);
            if (!title || seen.has(title)) continue;

            let holder = linkEl;
            let hotText = '';
            for (let up = 0; up < 5 && holder; up += 1) {
                const holderText = (holder.innerText || '') + '';
                const hm = holderText.match(/(\d+(?:\.\d+)?\s*万?\s*热度)/);
                if (hm) {
                    hotText = hm[1].replace(/\s+/g, '');
                    break;
                }
                holder = holder.parentElement;
            }

            const rankEl = holder ? holder.querySelector('[class*="listStyle"], [class*="rank"], [class*="index"]') : null;
            let rank = rankEl ? rankEl.textContent.trim() : '';
            if (!rank && holder) {
                const rankLine = (holder.innerText || '').match(/^\s*(\d{1,3})\s*[\r\n]/);
                if (rankLine) rank = rankLine[1];
            }

            seen.add(title);
            items.push({
                rank: rank || String(items.length + 1),
                title,
                hot_value: hotText,
                url: linkEl.href
            });
            if (items.length >= 50) break;
        }

        // 兜底：从整页文本里抓“数字. 标题”结构
        if (items.length === 0) {
            const bodyText = document.body?.innerText || '';
            for (const line of bodyText.split('\n')) {
                const m = line.trim().match(/^(\d{1,3})[.、]\s*(.{2,40})/);
                if (!m || seen.has(m[2])) continue;
                seen.add(m[2]);
                items.push({ rank: m[1], title: m[2], hot_value: '', url: '' });
            }
        }

        info.items = items;
        info.item_count = items.length;
        if (info.item_count === 0) {
            info.warnings = ['未提取到热搜榜：可能未登录或页面结构变化'];
        }

        return { type: 'hot_board', ...info };
    }

    // ========== 直播弹幕提取（实验性，依赖主世界 IM/WebSocket 拦截） ==========

    const DANMAKU_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_DANMAKU_CACHE_REQUEST';
    const DANMAKU_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_DANMAKU_CACHE_RESPONSE';

    function queryCachedDanmakuFromMainWorld(limit = 200) {
        const requestId = `vcp-danmaku-${Date.now()}-${++mainWorldRequestSeq}`;
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
                if (data.type !== DANMAKU_CACHE_RESPONSE_EVENT || data.requestId !== requestId) return;
                finish({
                    success: data.success,
                    count: Number(data.count || 0),
                    room_ids: Array.isArray(data.room_ids) ? data.room_ids : [],
                    messages: Array.isArray(data.messages) ? data.messages : []
                });
            };
            window.addEventListener('message', onMessage);
            window.dispatchEvent(new CustomEvent(DANMAKU_CACHE_REQUEST_EVENT, {
                detail: { requestId, limit }
            }));
            setTimeout(() => finish({ success: false, count: 0, room_ids: [], messages: [] }), 300);
        });
    }

    async function extractLiveDanmaku(options = {}) {
        const info = {};
        info.url = window.location.href;
        const limit = Number(options.danmaku_num) > 0 ? Number(options.danmaku_num) : 200;

        const cached = await queryCachedDanmakuFromMainWorld(limit);
        if (cached && cached.messages && cached.messages.length) {
            info.messages = cached.messages;
            info.count = cached.count;
            info.room_ids = cached.room_ids;
            info.hint = '直播弹幕来自主世界 IM/WebSocket 拦截（实验性，protobuf 弹幕为启发式解码）';
        } else {
            info.messages = [];
            info.count = 0;
            info.warnings = ['未捕获到直播弹幕：仅直播页面有效，且需要主世界 IM/WebSocket 拦截成功（实验性）'];
        }

        return { type: 'live_danmaku', ...info };
    }

    // ========== 视频字幕提取（自带字幕优先，否则交给服务端 ASR 转写） ==========

    async function extractVideoCaptions(options = {}) {
        const info = {};
        const url = window.location.href;
        info.url = url;

        const urlId = (url.match(/\/(video|note)\/(\d+)/) || [])[2] || '';
        let id = urlId;
        if (!id) {
            const extracted = extractAwemeIdFromElementContext(getPrimaryPlayingVideoElement() || document.body);
            id = extracted.id;
        }
        info.content_id = id;
        if (!id) {
            info.status = 'no_video_id';
            info.warnings = ['未识别到视频 ID，请打开视频详情页后重试'];
            return { type: 'video_captions', ...info };
        }

        let cached = await queryCachedAwemeFromMainWorld(id);
        // 新标签页里视频详情 API 可能尚未加载完成，轮询主世界缓存等待 play_url
        if (!cached || !cached.play_url) {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                await new Promise(r => setTimeout(r, 800));
                cached = await queryCachedAwemeFromMainWorld(id);
                if (cached && cached.play_url) break;
            }
        }
        if (cached && Array.isArray(cached.captions) && cached.captions.length) {
            info.status = 'builtin_subtitles_found';
            info.caption_source = 'builtin';
            info.captions = cached.captions;
        } else {
            info.status = 'no_builtin_subtitles';
            info.captions = [];
            info.needs_asr = true;
            info.play_url = cached?.play_url || '';
            info.desc = cached?.desc || '';
        }

        return { type: 'video_captions', ...info };
    }

    // ========== 图文笔记提取 ==========

    async function extractNoteInfo() {
        const info = {};

        // 标题/描述 — 复用视频页选择器
        const descEl = document.querySelector('[data-e2e="video-desc"]') ||
                       document.querySelector('.video-info-detail .title') ||
                       document.querySelector('.SEOTitle') ||
                       document.querySelector('[class*="title"][class*="video"]') ||
                       document.querySelector('[class*="desc"][class*="note"]') ||
                       document.querySelector('h1');
        info.title = descEl ? descEl.textContent.trim() : document.title;

        // 标签
        const tagEls = document.querySelectorAll('[data-e2e="video-desc"] a, a[href*="/hashtag/"], a[class*="hashtag"]');
        info.tags = [...tagEls].map(el => el.textContent.trim()).filter(t => t.startsWith('#'));

        // 互动数据 — 复用视频页选择器
        const likeEl = document.querySelector('[data-e2e="digg-count"]') ||
                       document.querySelector('.like-count') ||
                       document.querySelector('[class*="likeCount"]');
        info.likes = likeEl ? likeEl.textContent.trim() : '未知';

        const commentCountEl = document.querySelector('[data-e2e="comment-count"]') ||
                               document.querySelector('.comment-count') ||
                               document.querySelector('[class*="commentCount"]');
        info.comment_count = commentCountEl ? commentCountEl.textContent.trim() : '未知';

        const collectEl = document.querySelector('[data-e2e="collect-count"]') ||
                          document.querySelector('.collect-count') ||
                          document.querySelector('[class*="collectCount"]');
        info.collects = collectEl ? collectEl.textContent.trim() : '未知';

        const shareEl = document.querySelector('[data-e2e="share-count"]') ||
                        document.querySelector('.share-count') ||
                        document.querySelector('[class*="shareCount"]');
        info.shares = shareEl ? shareEl.textContent.trim() : '未知';

        // 作者信息
        const authorEl = document.querySelector('[data-e2e="video-author-info"]') ||
                         document.querySelector('.author-info') ||
                         document.querySelector('[class*="authorInfo"]') ||
                         document.querySelector('[class*="author-info"]');
        info.author = {};
        if (authorEl) {
            const nameEl = authorEl.querySelector('.name, .nickname, a, [class*="nickname"]');
            info.author.name = nameEl ? nameEl.textContent.trim() : '未知';
            const linkEl = authorEl.querySelector('a[href*="/user/"]');
            info.author.profile_url = linkEl ? linkEl.href : '';
        } else {
            const fallbackAuthor = document.querySelector('[data-e2e="browser-nickname"] span:first-child') ||
                                   document.querySelector('[class*="nickname"]');
            if (fallbackAuthor) {
                info.author.name = fallbackAuthor.textContent.trim();
            }
        }

        // 发布时间
        const timeEl = document.querySelector('[data-e2e="browser-nickname"] span.time') ||
                       document.querySelector('.video-publish-time') ||
                       document.querySelector('time') ||
                       document.querySelector('[class*="publishTime"]');
        info.publish_time = timeEl ? timeEl.textContent.trim() : '未知';

        // ===== 图文笔记特有：图片URL提取 =====
        const imageEls = document.querySelectorAll(
            '[data-e2e="note-slide-list"] img, ' +
            '.note-content img, ' +
            '[class*="slide"] img[src*="douyin"], ' +
            '[class*="slide"] img[src*="byteimg"], ' +
            '[class*="carousel"] img, ' +
            '[class*="image-list"] img, ' +
            '[class*="swiper"] img[src*="byteimg"], ' +
            '[class*="note"] img[src*="byteimg"]'
        );
        info.images = [...imageEls].map(img => ({
            src: img.src || img.dataset?.src || '',
            alt: img.alt || ''
        })).filter(img => img.src && !img.src.startsWith('data:'));

        info.image_count = info.images.length;
        info.content_type = 'note';
        info.note_id = (window.location.href.match(/\/note\/(\d+)/) || [])[1] || '';
        info.url = window.location.href;

        return { type: 'note_info', ...info };
    }

    // ========== 完整提取（视频+评论+作者+图文） ==========

    async function extractFullData(options = {}) {
        const result = {};

        const url = window.location.href;

        if (url.includes('/hot')) {
            result.hot_board = await extractHotBoard();
        } else if (/\/live\//i.test(url)) {
            result.live_danmaku = await extractLiveDanmaku(options);
        } else if (url.includes('/search')) {
            result.search = await extractSearchResults(options);
        } else if (url.includes('/note/')) {
            result.note = await extractNoteInfo();
            result.comments = await extractComments(options);
        } else if (url.includes('/video/')) {
            result.video = await extractVideoInfo();
            result.comments = await extractComments(options);
        } else if (url.includes('/user/')) {
            result.author = await extractAuthorInfo();
            const showTabMatch = url.match(/[?&]showTab=([^&#]+)/);
            let activeTab = showTabMatch ? decodeURIComponent(showTabMatch[1]).toLowerCase() : 'post';
            if (activeTab === 'fav_collection' || activeTab === 'fav') activeTab = 'collect';
            result.tab_list = await extractProfileList(activeTab);
        } else {
            result.video = await extractVideoInfo();
            result.comments = await extractComments(options);
        }

        result.type = 'full_extraction';
        result.source_url = url;
        result.extracted_at = new Date().toISOString();

        return result;
    }

    // ========== 视频元素与ID提取 ==========

    function getPrimaryPlayingVideoElement() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;

        const scored = videos.map((video) => {
            const rect = video.getBoundingClientRect();
            const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            const visibleArea = visibleWidth * visibleHeight;
            const playingBoost = (!video.paused && !video.ended) ? 100000000 : 0;
            return { video, score: visibleArea + playingBoost };
        }).sort((a, b) => b.score - a.score);

        return scored[0]?.video || null;
    }

    /**
     * 从视频元素的DOM上下文中提取 aweme_id
     * 参考了成功插件的 F() 函数逻辑
     */
    function extractAwemeIdFromElementContext(videoEl) {
        if (!videoEl) return { id: '', source: 'no_element' };

        // 策略1: data-e2e-vid 属性（最可靠）
        let node = videoEl;
        for (let depth = 0; node && depth < 10; depth++) {
            const vidHost = node.closest?.('[data-e2e-vid]') || node.querySelector?.('[data-e2e-vid]');
            const dataVid = vidHost?.dataset?.e2eVid || vidHost?.getAttribute?.('data-e2e-vid') || '';
            if (dataVid && /^\d{8,}$/.test(dataVid)) {
                return { id: dataVid, source: 'data-e2e-vid' };
            }
            node = node.parentElement;
        }

        // 策略2: 祖先 a[href] 中的 /video/ID
        node = videoEl;
        for (let depth = 0; node && depth < 10; depth++) {
            const anchor = node.closest?.('a[href]');
            const href = anchor?.getAttribute?.('href') || anchor?.href || '';
            const match = href.match(/\/video\/(\d{8,})/i);
            if (match?.[1]) {
                return { id: match[1], source: 'a[href]' };
            }

            // div[href] 也可能有
            const divHref = node.closest?.('div[href]');
            const divHrefValue = divHref?.getAttribute?.('href') || '';
            const divMatch = divHrefValue.match(/\/video\/(\d{8,})/i);
            if (divMatch?.[1]) {
                return { id: divMatch[1], source: 'div[href]' };
            }

            node = node.parentElement;
        }

        // 策略3: 搜索结果卡片中的 class 名
        const searchCard = videoEl.closest?.('.search-result-card');
        if (searchCard) {
            const playerContainer = searchCard.querySelector?.('.basePlayerContainer');
            if (playerContainer?.classList) {
                for (const cls of playerContainer.classList) {
                    const matched = cls.match(/video_(\d{8,})/i);
                    if (matched?.[1]) {
                        return { id: matched[1], source: 'class:video_*' };
                    }
                }
            }
        }

        // 策略4: 遍历祖先节点的所有属性
        node = videoEl;
        for (let depth = 0; node && depth < 8; depth++) {
            if (node.getAttributeNames) {
                for (const attrName of node.getAttributeNames()) {
                    const val = node.getAttribute(attrName) || '';
                    const idMatch = val.match(/\/video\/(\d{8,})/i) ||
                                    val.match(/\baweme[_-]?id["'=:\s]+(\d{8,})/i) ||
                                    val.match(/\bvideo[_-]?id["'=:\s]+(\d{8,})/i);
                    if (idMatch?.[1]) {
                        return { id: idMatch[1], source: `attr:${attrName}@depth${depth}` };
                    }
                }
            }
            node = node.parentElement;
        }

        return { id: '', source: 'not_found' };
    }

    function detectDouyinPageType() {
        const href = window.location.href;
        if (/\/video\/\d+/i.test(href)) return 'detail';
        if (/\/note\/\d+/i.test(href)) return 'note';
        if (/recommend/i.test(href) || /^https:\/\/www\.douyin\.com\/?\??$/i.test(href)) return 'recommend';
        if (/\/search/i.test(href)) return 'search';
        if (/\/follow/i.test(href)) return 'follow';
        if (/\/friend/i.test(href)) return 'friend';
        if (/\/hot/i.test(href)) return 'hot';
        if (/\/discover/i.test(href)) return 'discover';
        return 'unknown';
    }

    // ========== 从主世界获取缓存的播放地址（只返回字符串URL） ==========

    /**
     * 向主世界查询缓存的 aweme 数据
     * 返回: { play_url: string, desc: string, author_name: string, source: string } | null
     * 注意：只返回纯字符串，不返回任何复杂对象，避免序列化问题
     */
    function queryCachedAwemeFromMainWorld(awemeId) {
        if (!awemeId) return Promise.resolve(null);
        const requestId = `vcp-cache-${Date.now()}-${++mainWorldRequestSeq}`;

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
                if (data.type !== MAIN_WORLD_CACHE_RESPONSE_EVENT) return;
                if (data.requestId !== requestId) return;

                if (data.success) {
                    finish({
                        play_url: String(data.play_url || ''),
                        desc: String(data.desc || ''),
                        author_name: String(data.author_name || ''),
                        source: String(data.source_info || 'main_world_cache'),
                        captions: Array.isArray(data.captions) ? data.captions : [],
                        // 旺财嗅探增强数据
                        statistics: data.statistics || null,
                        hashtags: data.hashtags || [],
                        author: data.author || null,
                        music: data.music || null,
                        duration: data.duration || 0,
                        create_time: data.create_time || 0,
                        video_width: data.video_width || 0,
                        video_height: data.video_height || 0,
                        share_url: data.share_url || '',
                        ip_location: data.ip_location || '',
                        is_ad: data.is_ad || false
                    });
                } else {
                    finish(null);
                }
            };

            window.addEventListener('message', onMessage);
            window.dispatchEvent(new CustomEvent(MAIN_WORLD_CACHE_REQUEST_EVENT, {
                detail: { requestId, awemeId }
            }));

            // 150ms 超时（主世界应该很快响应）
            setTimeout(() => finish(null), 150);
        });
    }

    function queryCachedCommentsFromMainWorld(awemeId) {
        if (!awemeId) return Promise.resolve(null);
        const requestId = `vcp-comment-cache-${Date.now()}-${++mainWorldRequestSeq}`;

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
                if (data.type !== MAIN_WORLD_COMMENT_CACHE_RESPONSE_EVENT) return;
                if (data.requestId !== requestId) return;

                if (data.success) {
                    finish({
                        total_count: Number(data.total_count || 0),
                        hot_comments: Array.isArray(data.hot_comments) ? data.hot_comments : [],
                        keywords_summary: Array.isArray(data.keywords_summary) ? data.keywords_summary : [],
                        source: String(data.source_info || 'main_world_comment_cache'),
                        cached_at: String(data.cached_at || '')
                    });
                } else {
                    finish(null);
                }
            };

            window.addEventListener('message', onMessage);
            window.dispatchEvent(new CustomEvent(MAIN_WORLD_COMMENT_CACHE_REQUEST_EVENT, {
                detail: { requestId, awemeId }
            }));

            setTimeout(() => finish(null), 180);
        });
    }

    // ========== 获取视频元信息（用于 extract / VCP 服务端） ==========

    async function getDouyinVideoMeta() {
        const videoEl = getPrimaryPlayingVideoElement() || document.querySelector('video');
        const videoIdFromUrl = (window.location.href.match(/\/video\/(\d+)/) || [])[1] || '';
        const contextResult = videoIdFromUrl
            ? { id: videoIdFromUrl, source: 'url:/video/{id}' }
            : extractAwemeIdFromElementContext(videoEl);
        const videoId = contextResult?.id || '';
        const videoIdSource = contextResult?.source || 'unknown';

        // 从主世界查询缓存（只拿字符串）
        const cached = await queryCachedAwemeFromMainWorld(videoId);

        const title = (
            cached?.desc ||
            document.querySelector('[data-e2e="video-desc"]')?.textContent ||
            document.querySelector('.video-info-detail .title')?.textContent ||
            document.querySelector('.SEOTitle')?.textContent ||
            document.querySelector('h1')?.textContent ||
            document.title
        ).trim();

        const authorName = (
            cached?.author_name ||
            document.querySelector('[data-e2e="video-author-info"] .name')?.textContent ||
            document.querySelector('[data-e2e="video-author-info"] a')?.textContent ||
            document.querySelector('.author-info .name')?.textContent ||
            document.querySelector('.video-info-detail .author')?.textContent ||
            document.querySelector('[data-e2e="browser-nickname"]')?.textContent ||
            ''
        ).trim();

        const pageType = detectDouyinPageType();

        // 构建 meta —— 全部是纯字符串/布尔值/数字，绝对不含复杂对象
        const meta = {
            video_id: videoId,
            video_id_source: videoIdSource,
            page_type: pageType,
            title: title,
            author_name: authorName,
            // 缓存的播放地址（纯字符串URL）
            cached_play_url: cached?.play_url || '',
            cached_play_url_source: cached?.source || '',
            // 页面上 video 元素的 src（可能是 blob:）
            video_element_src: (videoEl?.currentSrc || videoEl?.src || '').trim(),
            source_url: window.location.href,
            content_script_version: CONTENT_SCRIPT_VERSION,
            extracted_at: new Date().toISOString()
        };

        console.log('[VCPBridge] getDouyinVideoMeta:', {
            version: CONTENT_SCRIPT_VERSION,
            pageType: meta.page_type,
            videoId: meta.video_id || '[empty]',
            videoIdSource: meta.video_id_source,
            hasCachedPlayUrl: !!meta.cached_play_url,
            cachedPlayUrlSource: meta.cached_play_url_source,
            cachedPlayUrlPreview: meta.cached_play_url ? meta.cached_play_url.slice(0, 120) : ''
        });

        return meta;
    }

    // ========== 下载流程（核心修复） ==========

    /**
     * 执行下载流程
     * 关键改动：只传最小数据给后台，避免序列化问题
     * 参考成功插件模式：内容脚本只传 video_id + 基本文本，后台负责所有复杂逻辑
     */
    async function doDownloadFlow() {
        const meta = await getDouyinVideoMeta();

        // 构建发给后台的消息 —— 全部是纯字符串，绝对安全
        const downloadMessage = {
            type: 'downloadCurrentVideo',
            video_id: String(meta.video_id || ''),
            video_id_source: String(meta.video_id_source || ''),
            page_type: String(meta.page_type || ''),
            title: String(meta.title || ''),
            author_name: String(meta.author_name || ''),
            cached_play_url: String(meta.cached_play_url || ''),
            source_url: String(meta.source_url || window.location.href),
            content_script_version: CONTENT_SCRIPT_VERSION
        };

        // 诊断日志：打印消息大小
        const msgStr = JSON.stringify(downloadMessage);
        console.log('[VCPBridge] 发送下载消息到后台:', {
            messageSize: msgStr.length,
            videoId: downloadMessage.video_id || '[empty]',
            pageType: downloadMessage.page_type,
            hasCachedPlayUrl: !!downloadMessage.cached_play_url,
            cachedPlayUrlPreview: downloadMessage.cached_play_url ? downloadMessage.cached_play_url.slice(0, 120) : ''
        });

        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(downloadMessage, (resp) => {
                    if (chrome.runtime.lastError) {
                        const errMsg = chrome.runtime.lastError.message || '下载消息发送失败';
                        console.error('[VCPBridge] sendMessage 失败:', errMsg);
                        reject(new Error(errMsg));
                        return;
                    }
                    console.log('[VCPBridge] 后台下载响应:', resp);
                    resolve(resp || { success: false, error: '后台返回为空' });
                });
            } catch (e) {
                console.error('[VCPBridge] sendMessage 异常:', e);
                reject(e);
            }
        });
    }

    // ========== 投喂 ==========

    async function feedCurrentVideoToServer() {
        // 1. DOM 提取基础数据（含评论）
        const data = await extractFullData({ comment_count: 30, include_replies: true, sort_by: 'likes' });

        // 2. 尝试从主世界 aweme 缓存获取 API 级精确数据（旺财嗅探增强）
        const videoIdFromUrl = (window.location.href.match(/\/video\/(\d+)/) || [])[1] || '';
        const videoEl = getPrimaryPlayingVideoElement() || document.querySelector('video');
        const contextResult = videoIdFromUrl
            ? { id: videoIdFromUrl }
            : extractAwemeIdFromElementContext(videoEl);
        let videoId = contextResult?.id || '';
        const pageType = detectDouyinPageType();

        let apiEnrichedData = null;
        let commentApiData = null;
        let feedWarning = null;

        // 推荐流兜底：当 videoId 提取失败时，尝试从主世界获取最近缓存的 aweme
        if (!videoId && (pageType === 'recommend' || pageType === 'follow' || pageType === 'friend' || pageType === 'hot')) {
            console.log('[VCPBridge] 投喂增强：推荐流页面 videoId 提取失败，尝试查询最近缓存...', { pageType });
            try {
                const recentCached = await queryRecentCachedAwemeFromMainWorld();
                if (recentCached && recentCached.aweme_id) {
                    videoId = recentCached.aweme_id;
                    console.log('[VCPBridge] 投喂增强：使用最近缓存的 aweme 数据', {
                        videoId,
                        desc: recentCached.desc?.slice(0, 30),
                        cacheSize: recentCached.cache_size
                    });
                    // 直接使用最近缓存的数据，无需再次查询
                    apiEnrichedData = {
                        api_statistics: recentCached.statistics,
                        api_hashtags: recentCached.hashtags,
                        api_author: recentCached.author,
                        api_music: recentCached.music,
                        video_duration: recentCached.duration,
                        create_time: recentCached.create_time,
                        video_width: recentCached.video_width,
                        video_height: recentCached.video_height,
                        share_url: recentCached.share_url,
                        ip_location: recentCached.ip_location,
                        is_ad: recentCached.is_ad,
                        aweme_cache_source: recentCached.source + ':recent_fallback'
                    };
                    // 推荐流兜底拿到 videoId 后，也尝试查询评论缓存（含预热+重试）
                    try {
                        let recentComments = await queryCachedCommentsFromMainWorld(videoId);
                        if (!recentComments) {
                            // 缓存未命中：主动触发评论预热
                            console.log('[VCPBridge] 投喂增强(推荐流)：评论缓存未命中，启动主动预热...', { videoId });
                            try {
                                await prewarmCommentInMainWorld(videoId);
                                // 预热后等待异步缓存完成
                                await new Promise(r => setTimeout(r, 600));
                                recentComments = await queryCachedCommentsFromMainWorld(videoId);
                                if (!recentComments) {
                                    // 二次重试
                                    await new Promise(r => setTimeout(r, 800));
                                    recentComments = await queryCachedCommentsFromMainWorld(videoId);
                                }
                            } catch (prewarmErr) {
                                console.warn('[VCPBridge] 投喂增强(推荐流)：评论预热失败', prewarmErr?.message || prewarmErr);
                            }
                        }
                        if (recentComments) {
                            commentApiData = {
                                total_count: recentComments.total_count,
                                hot_comments: recentComments.hot_comments,
                                keywords_summary: recentComments.keywords_summary,
                                comment_cache_source: recentComments.source + ':recent_fallback',
                                cached_at: recentComments.cached_at
                            };
                            console.log('[VCPBridge] 投喂增强(推荐流)：已合并评论 API 数据', {
                                videoId,
                                totalCount: recentComments.total_count,
                                hotCommentCount: recentComments.hot_comments?.length || 0
                            });
                        } else {
                            console.log('[VCPBridge] 投喂增强(推荐流)：评论预热+重试后仍无数据', { videoId });
                        }
                    } catch (_) { /* 评论缓存查询失败不影响主流程 */ }
                    feedWarning = '⚠️ 推荐流页面：videoId 通过最近缓存匹配，可能不是当前正在播放的视频。建议点击进入视频详情页后再投喂以获取更准确的数据。';
                } else {
                    console.warn('[VCPBridge] 投喂增强：推荐流兜底失败，主世界缓存为空');
                    feedWarning = '⚠️ 推荐流页面：无法提取视频ID且缓存为空。请点击进入视频详情页后再投喂。';
                }
            } catch (e) {
                console.warn('[VCPBridge] 投喂增强：推荐流兜底异常', e?.message || e);
            }
        }

        if (videoId && !apiEnrichedData) {
            let [cached, cachedComments] = await Promise.all([
                queryCachedAwemeFromMainWorld(videoId),
                queryCachedCommentsFromMainWorld(videoId)
            ]);

            // P3 修复：缓存未命中时主动触发 prewarm，获取完整 aweme 数据（含作者信息）
            if (!cached) {
                console.log('[VCPBridge] 投喂增强：aweme 缓存未命中，触发主世界 prewarm...', { videoId });
                try {
                    await prewarmAwemeDetailInMainWorld(videoId, window.location.href);
                    // prewarm 的 fetch 会被已安装的 XHR/fetch hook 自动拦截并缓存
                    // 等待一小段时间让缓存写入完成
                    await new Promise(r => setTimeout(r, 200));
                    // 重新查询缓存
                    cached = await queryCachedAwemeFromMainWorld(videoId);
                    if (cached) {
                        console.log('[VCPBridge] 投喂增强：prewarm 成功，已获取 API 缓存数据', { videoId });
                    } else {
                        console.warn('[VCPBridge] 投喂增强：prewarm 完成但缓存仍未命中', { videoId });
                    }
                } catch (e) {
                    console.warn('[VCPBridge] 投喂增强：prewarm 失败，将仅使用 DOM 数据', { videoId, error: e?.message || e });
                }
            }

            if (cached) {
                apiEnrichedData = {
                    // API 精确统计（数字而非 DOM 文本）
                    api_statistics: cached.statistics,
                    // API 话题标签
                    api_hashtags: cached.hashtags,
                    // API 完整作者信息
                    api_author: cached.author,
                    // API BGM/音乐信息
                    api_music: cached.music,
                    // 视频元数据
                    video_duration: cached.duration,
                    create_time: cached.create_time,
                    video_width: cached.video_width,
                    video_height: cached.video_height,
                    share_url: cached.share_url,
                    ip_location: cached.ip_location,
                    is_ad: cached.is_ad,
                    aweme_cache_source: cached.source
                };
                console.log('[VCPBridge] 投喂增强：已合并 API 缓存数据', {
                    videoId,
                    hasStats: !!cached.statistics,
                    hashtagCount: cached.hashtags?.length || 0,
                    hasAuthor: !!cached.author?.nickname
                });
            }

            if (cachedComments) {
                commentApiData = {
                    total_count: cachedComments.total_count,
                    hot_comments: cachedComments.hot_comments,
                    keywords_summary: cachedComments.keywords_summary,
                    comment_cache_source: cachedComments.source,
                    cached_at: cachedComments.cached_at
                };
                console.log('[VCPBridge] 投喂增强：已合并评论 API 数据', {
                    videoId,
                    totalCount: cachedComments.total_count,
                    hotCommentCount: cachedComments.hot_comments?.length || 0,
                    keywordCount: cachedComments.keywords_summary?.length || 0
                });
            } else {
                // v1.6.0 P5 评论增强：缓存未命中时，主动触发评论预热请求
                // 在推荐大厅中，用户不会打开评论面板，评论 API 不会自然触发
                // 因此需要主动请求评论 API 来获取数据
                console.log('[VCPBridge] 投喂增强：评论缓存未命中，启动主动预热...', { videoId });

                try {
                    const prewarmResult = await prewarmCommentInMainWorld(videoId);
                    console.log('[VCPBridge] 投喂增强：评论预热完成', {
                        videoId,
                        cached_count: prewarmResult.cached_count,
                        total_count: prewarmResult.total_count,
                        status: prewarmResult.status
                    });

                    // P6 修复：prewarm 返回 cached_count 可能为 0（时序竞争：
                    // fetch hook 异步处理可能晚于 prewarm 自身的 cacheCommentFromPayload 调用）
                    // 因此无论 cached_count 是多少，都等待一小段时间后查询缓存
                    if (prewarmResult.cached_count === 0) {
                        // XHR/fetch hook 可能还在异步处理中，等待其完成
                        await new Promise(r => setTimeout(r, 500));
                    }

                    const retryComments = await queryCachedCommentsFromMainWorld(videoId);
                    if (retryComments) {
                        commentApiData = {
                            total_count: retryComments.total_count,
                            hot_comments: retryComments.hot_comments,
                            keywords_summary: retryComments.keywords_summary,
                            comment_cache_source: retryComments.source + ':prewarm',
                            cached_at: retryComments.cached_at
                        };
                        console.log('[VCPBridge] 投喂增强：评论预热后获取成功', {
                            videoId,
                            totalCount: retryComments.total_count,
                            hotCommentCount: retryComments.hot_comments?.length || 0
                        });
                    } else {
                        // 再等一轮（fetch hook 完全异步处理可能需要更多时间）
                        await new Promise(r => setTimeout(r, 800));
                        const retryComments2 = await queryCachedCommentsFromMainWorld(videoId);
                        if (retryComments2) {
                            commentApiData = {
                                total_count: retryComments2.total_count,
                                hot_comments: retryComments2.hot_comments,
                                keywords_summary: retryComments2.keywords_summary,
                                comment_cache_source: retryComments2.source + ':prewarm-delayed',
                                cached_at: retryComments2.cached_at
                            };
                            console.log('[VCPBridge] 投喂增强：评论延迟重试成功', {
                                videoId,
                                totalCount: retryComments2.total_count,
                                hotCommentCount: retryComments2.hot_comments?.length || 0
                            });
                        } else {
                            console.log('[VCPBridge] 投喂增强：评论预热后仍无缓存数据', { videoId });
                        }
                    }
                } catch (prewarmError) {
                    console.warn('[VCPBridge] 投喂增强：评论预热失败，回退到等待重试', {
                        videoId,
                        error: prewarmError?.message || prewarmError
                    });

                    // 预热失败时回退到原来的被动等待策略
                    await new Promise(r => setTimeout(r, 500));
                    const retryComments = await queryCachedCommentsFromMainWorld(videoId);
                    if (retryComments) {
                        commentApiData = {
                            total_count: retryComments.total_count,
                            hot_comments: retryComments.hot_comments,
                            keywords_summary: retryComments.keywords_summary,
                            comment_cache_source: retryComments.source + ':retry-fallback',
                            cached_at: retryComments.cached_at
                        };
                        console.log('[VCPBridge] 投喂增强：评论回退重试成功', {
                            videoId,
                            totalCount: retryComments.total_count,
                            hotCommentCount: retryComments.hot_comments?.length || 0
                        });
                    } else {
                        console.log('[VCPBridge] 投喂增强：评论预热失败且重试仍未命中', { videoId });
                    }
                }
            }
        }

        // v1.6.0 修复：API 精确数据覆盖 DOM 提取的 "未知" 值
        // 当 apiEnrichedData 存在时，用 API 数据补全/覆盖 DOM 提取中缺失的字段
        if (apiEnrichedData && data?.video) {
            const stats = apiEnrichedData.api_statistics;
            if (stats) {
                if (data.video.likes === '未知' && stats.digg_count !== undefined) {
                    data.video.likes = String(stats.digg_count);
                }
                if (data.video.comment_count === '未知' && stats.comment_count !== undefined) {
                    data.video.comment_count = String(stats.comment_count);
                }
                if (data.video.collects === '未知' && stats.collect_count !== undefined) {
                    data.video.collects = String(stats.collect_count);
                }
                if (data.video.shares === '未知' && stats.share_count !== undefined) {
                    data.video.shares = String(stats.share_count);
                }
            }
            const apiAuthor = apiEnrichedData.api_author;
            if (apiAuthor) {
                if (!data.video.author || !data.video.author.name || data.video.author.name === '未知') {
                    data.video.author = data.video.author || {};
                    data.video.author.name = apiAuthor.nickname || data.video.author.name || '未知';
                    data.video.author.uid = apiAuthor.uid || '';
                    data.video.author.unique_id = apiAuthor.unique_id || '';
                    data.video.author.signature = apiAuthor.signature || '';
                    data.video.author.follower_count = apiAuthor.follower_count || 0;
                }
            }
            if (data.video.bgm === '未知' && apiEnrichedData.api_music?.title) {
                data.video.bgm = apiEnrichedData.api_music.title;
                if (apiEnrichedData.api_music.author) {
                    data.video.bgm += ` - ${apiEnrichedData.api_music.author}`;
                }
            }
            if (data.video.publish_time === '未知' && apiEnrichedData.create_time) {
                try {
                    data.video.publish_time = new Date(apiEnrichedData.create_time * 1000).toLocaleString('zh-CN');
                } catch (_) { /* 忽略格式化错误 */ }
            }
            if ((!data.video.tags || data.video.tags.length === 0) && apiEnrichedData.api_hashtags?.length) {
                data.video.tags = apiEnrichedData.api_hashtags;
            }
            console.log('[VCPBridge] v1.6.0 API数据已覆盖DOM缺失字段', {
                likes: data.video.likes,
                comment_count: data.video.comment_count,
                collects: data.video.collects,
                shares: data.video.shares,
                author: data.video.author?.name,
                bgm: data.video.bgm,
                tagsCount: data.video.tags?.length || 0
            });
        }

        chrome.runtime.sendMessage({
            type: 'feedToServer',
            data: {
                extract_type: 'douyin_full',
                page_type: pageType,
                extractedData: data,
                apiEnrichedData: apiEnrichedData,
                comments: commentApiData,
                video_id: videoId,
                feed_warning: feedWarning,
                sourceUrl: window.location.href
            }
        });
        return { message: feedWarning
            ? `已投喂（${feedWarning}）`
            : '已投喂当前抖音视频数据（含旺财嗅探增强与评论API）' };
    }

    // ========== 主世界查询最近缓存（推荐流兜底） ==========

    const MAIN_WORLD_RECENT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_RECENT_CACHE_REQUEST';
    const MAIN_WORLD_RECENT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_RECENT_CACHE_RESPONSE';

    /**
     * 向主世界查询最近缓存的 aweme 数据（推荐流中无法提取 videoId 时的兜底方案）
     * 返回与 queryCachedAwemeFromMainWorld 相同格式的对象，额外包含 aweme_id 字段
     */
    function queryRecentCachedAwemeFromMainWorld() {
        const requestId = `vcp-recent-${Date.now()}-${++mainWorldRequestSeq}`;

        return new Promise((resolve) => {
            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                resolve(value);
            };

            const onMessage = (event) => {
                if (event.data?.source !== 'VCPBridge') return;
                if (event.data?.type !== MAIN_WORLD_RECENT_CACHE_RESPONSE_EVENT) return;
                if (event.data?.requestId !== requestId) return;

                if (event.data.success) {
                    finish({
                        aweme_id: event.data.aweme_id || '',
                        play_url: event.data.play_url || '',
                        desc: event.data.desc || '',
                        author_name: event.data.author_name || '',
                        source: event.data.source_info || 'recent_cache',
                        all_play_urls: event.data.all_play_urls || [],
                        statistics: event.data.statistics || null,
                        hashtags: event.data.hashtags || [],
                        author: event.data.author || null,
                        music: event.data.music || null,
                        duration: event.data.duration || 0,
                        create_time: event.data.create_time || 0,
                        video_width: event.data.video_width || 0,
                        video_height: event.data.video_height || 0,
                        share_url: event.data.share_url || '',
                        ip_location: event.data.ip_location || '',
                        is_ad: event.data.is_ad || false,
                        cache_size: event.data.cache_size || 0
                    });
                } else {
                    finish(null);
                }
            };

            window.addEventListener('message', onMessage);

            const timer = setTimeout(() => {
                finish(null);
            }, 300);

            // 修复 v1.6.0：必须使用 window.dispatchEvent，因为主世界在 window 上监听
            // （之前误用 document.dispatchEvent 导致推荐流兜底查询永远超时失败）
            window.dispatchEvent(new CustomEvent(MAIN_WORLD_RECENT_CACHE_REQUEST_EVENT, {
                detail: { requestId }
            }));
        });
    }

    // ========== 主世界预热 ==========

    const MAIN_WORLD_PREWARM_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_DETAIL_PREWARM_REQUEST';
    const MAIN_WORLD_PREWARM_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_DETAIL_PREWARM_RESPONSE';

    async function prewarmAwemeDetailInMainWorld(awemeId, sourceUrl) {
        if (!awemeId) {
            throw new Error('页面预热缺少 awemeId');
        }

        return new Promise((resolve, reject) => {
            const requestId = `vcp-prewarm-${Date.now()}-${++mainWorldRequestSeq}`;
            let settled = false;

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                fn(value);
            };

            const onMessage = (event) => {
                const data = event?.data;
                if (!data || data.source !== 'VCPBridge') return;
                if (data.type !== MAIN_WORLD_PREWARM_RESPONSE_EVENT) return;
                if (data.requestId !== requestId) return;

                if (!data.success) {
                    finish(reject, new Error(data.error || '页面预热 aweme detail 失败'));
                    return;
                }

                finish(resolve, {
                    awemeId,
                    sourceUrl,
                    url: data.url || '',
                    status: data.status || 'ok',
                    play_url: data.play_url || '',
                    desc: data.desc || '',
                    author_name: data.author_name || '',
                    has_aweme_detail: !!data.has_aweme_detail
                });
            };

            window.addEventListener('message', onMessage);

            window.dispatchEvent(new CustomEvent(MAIN_WORLD_PREWARM_REQUEST_EVENT, {
                detail: { requestId, awemeId, sourceUrl }
            }));

            setTimeout(() => {
                finish(reject, new Error('页面预热 aweme detail 超时'));
            }, 10000);
        });
    }

    // ========== 主世界评论预热（P5：推荐大厅直接获取评论） ==========

    async function prewarmCommentInMainWorld(awemeId) {
        if (!awemeId) {
            throw new Error('评论预热缺少 awemeId');
        }

        return new Promise((resolve, reject) => {
            const requestId = `vcp-comment-prewarm-${Date.now()}-${++mainWorldRequestSeq}`;
            let settled = false;

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                fn(value);
            };

            const onMessage = (event) => {
                const data = event?.data;
                if (!data || data.source !== 'VCPBridge') return;
                if (data.type !== MAIN_WORLD_COMMENT_PREWARM_RESPONSE_EVENT) return;
                if (data.requestId !== requestId) return;

                if (!data.success) {
                    finish(reject, new Error(data.error || '评论预热失败'));
                    return;
                }

                finish(resolve, {
                    awemeId,
                    status: data.status || 'ok',
                    url: data.url || '',
                    cached_count: data.cached_count || 0,
                    total_count: data.total_count || 0
                });
            };

            window.addEventListener('message', onMessage);

            window.dispatchEvent(new CustomEvent(MAIN_WORLD_COMMENT_PREWARM_REQUEST_EVENT, {
                detail: { requestId, awemeId }
            }));

            setTimeout(() => {
                finish(reject, new Error('评论预热超时（15s）'));
            }, 15000);
        });
    }

    // ========== 工具函数 ==========

    function sanitizeFileNamePart(text = '') {
        return String(text || '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildDownloadFileName(meta = {}) {
        const videoId = meta.video_id || 'douyin_video';
        const author = sanitizeFileNamePart(meta.author_name) || 'douyin_author';
        const title = sanitizeFileNamePart(meta.title) || `video_${videoId}`;
        return `${author}_${title.slice(0, 30)}_${videoId}.mp4`;
    }

    function isDouyinVideoLikePage() {
        const href = window.location.href;
        return /douyin\.com\//i.test(href) || !!document.querySelector('video');
    }

    // ========== 悬浮球 ==========

    function injectHuskyFloat() {
        if (!isDouyinVideoLikePage()) return;
        if (document.getElementById('vcp-husky-float')) return;

        const POS_KEY = 'vcp_husky_float_pos_v1';
        const getMountNode = () => document.body;
        const loadPos = () => {
            try {
                const raw = localStorage.getItem(POS_KEY);
                if (!raw) return null;
                const p = JSON.parse(raw);
                if (typeof p.x === 'number' && typeof p.y === 'number') return p;
            } catch {}
            return null;
        };
        const savePos = (x, y) => {
            try {
                localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
            } catch {}
        };
        const clamp = (x, y) => {
            const w = 220;
            const h = 72;
            const maxX = Math.max(8, window.innerWidth - w);
            const maxY = Math.max(8, window.innerHeight - h);
            return {
                x: Math.min(Math.max(8, x), maxX),
                y: Math.min(Math.max(8, y), maxY)
            };
        };

        if (!getMountNode()) {
            console.warn('[VCPBridge] injectHuskyFloat skipped: document.body not ready');
            return;
        }

        const wrap = document.createElement('div');
        wrap.id = 'vcp-husky-float';
        wrap.setAttribute('data-vcp-role', 'husky-float');
        wrap.style.cssText = [
            'position: fixed !important',
            'left: 20px !important',
            'top: 120px !important',
            'right: auto !important',
            'bottom: auto !important',
            'z-index: 2147483647 !important',
            'display: flex !important',
            'flex-direction: column !important',
            'align-items: flex-start !important',
            'gap: 8px !important',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important',
            'pointer-events: auto !important',
            'visibility: visible !important',
            'opacity: 1 !important',
            'transform: translate3d(0, 0, 0) !important',
            'contain: layout style paint !important'
        ].join(';');

        const ensureVisible = () => {
            if (!wrap.isConnected) {
                const mountNode = getMountNode();
                if (mountNode) mountNode.appendChild(wrap);
            }
            wrap.style.display = 'flex';
            wrap.style.visibility = 'visible';
            wrap.style.opacity = '1';
            const rect = wrap.getBoundingClientRect();
            const outOfView = rect.width === 0 || rect.height === 0 ||
                rect.right < 0 || rect.bottom < 0 ||
                rect.left > window.innerWidth || rect.top > window.innerHeight;
            if (outOfView) {
                const next = clamp(20, 120);
                wrap.style.left = `${next.x}px`;
                wrap.style.top = `${next.y}px`;
                wrap.style.right = 'auto';
                wrap.style.bottom = 'auto';
                savePos(next.x, next.y);
            }
        };

        const saved = loadPos();
        const init = clamp(saved?.x ?? 20, saved?.y ?? 120);
        wrap.style.left = `${init.x}px`;
        wrap.style.top = `${init.y}px`;

        const panel = document.createElement('div');
        panel.style.cssText = [
            'display: none !important',
            'background: rgba(14,20,30,0.96) !important',
            'backdrop-filter: blur(8px) !important',
            'border: 1px solid rgba(100,160,255,0.35) !important',
            'border-radius: 12px !important',
            'padding: 10px !important',
            'width: 180px !important',
            'color: #d8ebff !important',
            'box-shadow: 0 8px 24px rgba(0,0,0,0.35) !important'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = '🐺 旺财工具';
        title.style.cssText = 'color:#9ed0ff !important;font-size:12px !important;margin-bottom:8px !important;font-weight:600 !important;';
        panel.appendChild(title);

        const createBtn = (label, onClick) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.style.cssText = [
                'appearance: none !important',
                '-webkit-appearance: none !important',
                'width:100% !important',
                'padding:6px 8px !important',
                'margin-bottom:6px !important',
                'border-radius:8px !important',
                'border:1px solid rgba(120,180,255,0.35) !important',
                'background:rgba(40,75,120,0.45) !important',
                'color:#d8ebff !important',
                'cursor:pointer !important',
                'font-size:12px !important',
                'line-height:1.4 !important'
            ].join(';');
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await onClick(btn);
                } catch (err) {
                    console.error('[VCPBridge] 按钮操作失败:', err);
                    btn.textContent = '❌ 失败';
                    setTimeout(() => { btn.textContent = label; }, 1500);
                }
            });
            return btn;
        };

        const downloadBtn = createBtn('⬇️ 下载视频', async (btn) => {
            btn.textContent = '⏳ 下载中...';

            try {
                const result = await doDownloadFlow();

                if (result?.success) {
                    btn.textContent = '✅ 已开始';
                    console.log('[VCPBridge] 下载任务已创建:', result);
                    setTimeout(() => { btn.textContent = '📁 下载中'; }, 900);
                    setTimeout(() => { btn.textContent = '⬇️ 下载视频'; }, 3000);
                } else {
                    btn.textContent = '❌ 下载失败';
                    console.warn('[VCPBridge] 下载失败:', result?.error || '未知错误');
                    setTimeout(() => { btn.textContent = '⬇️ 下载视频'; }, 2000);
                }
            } catch (e) {
                btn.textContent = '❌ 下载失败';
                console.error('[VCPBridge] 下载异常:', e?.message || e);
                setTimeout(() => { btn.textContent = '⬇️ 下载视频'; }, 2000);
            }
        });

        const feedBtn = createBtn('📤 投喂VCP', async (btn) => {
            btn.textContent = '投喂中...';
            await feedCurrentVideoToServer();
            btn.textContent = '✅ 已投喂';
            setTimeout(() => { btn.textContent = '📤 投喂VCP'; }, 1500);
        });

        const commentBtn = createBtn('📝 评论预览', async (btn) => {
            btn.textContent = '读取中...';
            const videoEl = getPrimaryPlayingVideoElement() || document.querySelector('video');
            const videoIdFromUrl = (window.location.href.match(/\/video\/(\d+)/) || [])[1] || '';
            const contextResult = videoIdFromUrl
                ? { id: videoIdFromUrl }
                : extractAwemeIdFromElementContext(videoEl);
            let videoId = contextResult?.id || '';
            let cachedComments = null;

            if (videoId) {
                cachedComments = await queryCachedCommentsFromMainWorld(videoId);
            }
            
            // 推荐流兜底：如果没有获取到videoId或者缓存评论，尝试使用推荐流最近的缓存
            if (!videoId || !cachedComments || !cachedComments.hot_comments?.length) {
                 const pageType = detectDouyinPageType();
                 if (pageType === 'recommend' || pageType === 'follow' || pageType === 'friend' || pageType === 'hot') {
                    console.log('[VCPBridge] 评论预览增强：尝试查询最近缓存...');
                    try {
                        const recentCached = await queryRecentCachedAwemeFromMainWorld();
                        if (recentCached && recentCached.aweme_id) {
                            videoId = recentCached.aweme_id;
                            cachedComments = await queryCachedCommentsFromMainWorld(videoId);
                        }
                    } catch(e) {}
                 }
            }


            if (!cachedComments || !cachedComments.hot_comments?.length) {
                btn.textContent = '暂无API评论';
                setTimeout(() => { btn.textContent = '📝 评论预览'; }, 1800);
                return;
            }

            const preview = cachedComments.hot_comments
                .slice(0, 3)
                .map((item, index) => `${index + 1}. ${item.user?.nickname || '匿名'}：${String(item.content || '').slice(0, 28)}`)
                .join('\n');

            console.log('[VCPBridge] 评论 API 预览:', {
                videoId,
                totalCount: cachedComments.total_count,
                preview,
                keywords: cachedComments.keywords_summary
            });

            btn.textContent = `💬 ${Math.min(cachedComments.hot_comments.length, 3)}条已记录`;
            btn.title = preview;
            setTimeout(() => {
                btn.textContent = '📝 评论预览';
                btn.title = '';
            }, 2500);
        });

        panel.appendChild(downloadBtn);
        panel.appendChild(feedBtn);
        panel.appendChild(commentBtn);

        const ball = document.createElement('button');
        ball.type = 'button';
        ball.textContent = '🐺';
        ball.style.cssText = [
            'appearance: none !important',
            '-webkit-appearance: none !important',
            'position: relative !important',
            'z-index: 2147483647 !important',
            'display: inline-flex !important',
            'align-items: center !important',
            'justify-content: center !important',
            'width:52px !important',
            'height:52px !important',
            'min-width:52px !important',
            'min-height:52px !important',
            'padding:0 !important',
            'margin:0 !important',
            'border-radius:50% !important',
            'border:none !important',
            'outline:none !important',
            'background:radial-gradient(circle at 30% 30%, #8ed0ff, #2f5f9f) !important',
            'color:#fff !important',
            'font-size:26px !important',
            'line-height:1 !important',
            'cursor:grab !important',
            'box-shadow:0 8px 20px rgba(0,0,0,0.35) !important',
            'pointer-events:auto !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'user-select:none !important',
            '-webkit-user-select:none !important',
            'touch-action:none !important'
        ].join(';');

        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        const onPointerMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
            const next = clamp(originLeft + dx, originTop + dy);
            wrap.style.left = `${next.x}px`;
            wrap.style.top = `${next.y}px`;
            wrap.style.right = 'auto';
            wrap.style.bottom = 'auto';
        };

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            ball.style.cursor = 'grab';
            const left = parseInt(wrap.style.left || '20', 10) || 20;
            const top = parseInt(wrap.style.top || '120', 10) || 120;
            savePos(left, top);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            ensureVisible();
        };

        ball.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = parseInt(wrap.style.left || '20', 10) || 20;
            originTop = parseInt(wrap.style.top || '120', 10) || 120;
            ball.style.cursor = 'grabbing';
            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', onPointerUp, true);
        });

        ball.addEventListener('click', (e) => {
            e.stopPropagation();
            if (moved) {
                moved = false;
                return;
            }
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            ensureVisible();
        });

        window.addEventListener('resize', () => {
            const left = parseInt(wrap.style.left || '20', 10) || 20;
            const top = parseInt(wrap.style.top || '120', 10) || 120;
            const next = clamp(left, top);
            wrap.style.left = `${next.x}px`;
            wrap.style.top = `${next.y}px`;
            savePos(next.x, next.y);
            ensureVisible();
        });

        document.addEventListener('click', () => {
            panel.style.display = 'none';
        });

        wrap.appendChild(ball);
        wrap.appendChild(panel);
        const mountNode = getMountNode();
        if (mountNode) {
            mountNode.appendChild(wrap);
        }
        setTimeout(ensureVisible, 0);
        setTimeout(ensureVisible, 400);
        setTimeout(ensureVisible, 1200);
    }

    function ensureHuskyFloatExists() {
        if (!isDouyinVideoLikePage()) return;
        if (!document.getElementById('vcp-husky-float')) {
            injectHuskyFloat();
        }
    }

    function bootHuskyFloatSafely() {
        try {
            ensureHuskyFloatExists();
        } catch (e) {
            console.warn('[VCPBridge] injectHuskyFloat failed:', e);
        }
    }

    bootHuskyFloatSafely();
    setInterval(bootHuskyFloatSafely, 2000);

    // SPA 路由切换兜底
    let __lastHref = window.location.href;
    setInterval(() => {
        if (window.location.href !== __lastHref) {
            __lastHref = window.location.href;
            setTimeout(bootHuskyFloatSafely, 600);
        }
    }, 500);

    // DOM被站点重绘时自动补回
    const observer = new MutationObserver(() => {
        if (!document.getElementById('vcp-husky-float')) {
            bootHuskyFloatSafely();
        }
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

    console.log('[VCPBridge] 🐺 抖音数据提取器已加载', {
        version: CONTENT_SCRIPT_VERSION,
        bootAt: CONTENT_SCRIPT_BOOT_TS,
        href: window.location.href
    });

    // 页面加载时通知后台，唤醒可能休眠的 Service Worker（MV3 保活）
    try {
        chrome.runtime.sendMessage({ type: 'content_ready' });
    } catch (e) {
        // 忽略：SW 唤醒失败不影响页面功能
    }
})();
