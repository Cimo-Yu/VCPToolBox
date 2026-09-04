// VCPBridge - 抖音主世界脚本
// 在页面主世界中运行，可以拦截页面的 XHR/fetch 请求
// v1.6.0 - 评论拦截修复：参考智小抖/社媒实现，修复 fetch hook、URL 匹配、签名参数缓存

(function () {
  'use strict';

  const CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_CACHE_REQUEST';
  const CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_CACHE_RESPONSE';
  const COMMENT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_CACHE_REQUEST';
  const COMMENT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_CACHE_RESPONSE';
  const PREWARM_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_DETAIL_PREWARM_REQUEST';
  const PREWARM_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_AWEME_DETAIL_PREWARM_RESPONSE';
  const COMMENT_PREWARM_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_PREWARM_REQUEST';
  const COMMENT_PREWARM_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_COMMENT_PREWARM_RESPONSE';
  const RECENT_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_RECENT_CACHE_REQUEST';
  const RECENT_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_RECENT_CACHE_RESPONSE';

  // aweme 缓存 Map: aweme_id -> { play_url, desc, author_name, statistics, tags, author, music, duration, create_time, ... }
  const awemeCache = new Map();
  // 评论缓存 Map: aweme_id -> { total_count, hot_comments, keywords_summary, source, cached_at }
  const commentCache = new Map();
  const MAX_CACHE_SIZE = 200;
  const MAX_COMMENT_CACHE_SIZE = 20; // 评论缓存限制（防止内存泄漏）

  // ========== 签名参数缓存（用于 prewarm 请求）==========
  // 抖音 API 需要 a_bogus/msToken/verifyFp 等动态签名参数，
  // 从拦截到的成功请求中缓存这些参数，prewarm 时复用
  const SIGN_PARAM_KEYS = new Set(['a_bogus', 'fp', 'verifyFp', 'msToken', 's_v_web_id', 'X-Bogus']);
  const signParamCache = []; // 数组，每项: [timestamp, Map(key->value)]
  const MAX_SIGN_CACHE_SIZE = 10;

  function cacheSignParams(urlStr) {
    try {
      const u = new URL(urlStr);
      const params = new Map();
      for (const [k, v] of u.searchParams) {
        if (SIGN_PARAM_KEYS.has(k) && v) {
          params.set(k, v);
        }
      }
      if (params.size >= 1) {
        signParamCache.push([Date.now(), params]);
        if (signParamCache.length > MAX_SIGN_CACHE_SIZE) {
          signParamCache.shift();
        }
      }
    } catch {}
  }

  function getLatestSignParams() {
    // 返回最新的签名参数，5分钟内有效
    for (let i = signParamCache.length - 1; i >= 0; i--) {
      const [ts, params] = signParamCache[i];
      if (Date.now() - ts < 5 * 60 * 1000) {
        return params;
      }
    }
    return null;
  }

  function applySignParams(urlStr, signParams) {
    if (!signParams) return urlStr;
    try {
      const u = new URL(urlStr);
      for (const [k, v] of signParams) {
        // 不覆盖已有的参数
        if (!u.searchParams.has(k)) {
          u.searchParams.set(k, v);
        }
      }
      return u.href;
    } catch {
      return urlStr;
    }
  }

  // ========== 评论 API 精确路径匹配（参考智小抖 DyApiMap）==========
  // 只拦截主评论列表，不拦截回复/子评论（/reply/）
  const COMMENT_API_PATHS = [
    '/aweme/v1/web/comment/list/',
    '/aweme/v2/web/comment/list/',
    '/comment/list/',
  ];

  // 回复评论路径（需要排除）
  const COMMENT_REPLY_PATHS = [
    '/comment/list/reply/',
    '/comment/list/reply',
  ];

  function isCommentReplyUrl(urlStr) {
    try {
      const pathname = new URL(urlStr).pathname;
      return COMMENT_REPLY_PATHS.some(p => pathname.indexOf(p) > -1);
    } catch {
      return false;
    }
  }

  function isCommentApiUrl(urlStr) {
    try {
      const pathname = new URL(urlStr).pathname;
      // 先排除回复评论路径
      if (isCommentReplyUrl(urlStr)) return false;
      return COMMENT_API_PATHS.some(p => pathname.indexOf(p) > -1);
    } catch {
      return false;
    }
  }

  function hasCommentPayload(payload) {
    return payload && (
      Array.isArray(payload.comments) ||
      Array.isArray(payload.comment_list) ||
      Array.isArray(payload?.data?.comments)
    );
  }

  // ========== URL 处理 ==========

  function normalizeVideoUrl(url = '') {
    return String(url || '')
      .trim()
      .replace('playwm', 'play')
      .replace(/^http:\/\//i, 'https://');
  }

  function isDouyinApiUrl(rawUrl = '') {
    const urlStr = String(rawUrl || '');
    // 匹配抖音/字节跳动的所有 API 域名（含评论、推荐流等子服务）
    return /https:\/\/(www\.douyin\.com|mcs\.zijieapi\.com|[\w-]+\.douyin\.com|[\w-]+\.amemv\.com|[\w-]+\.snssdk\.com|[\w-]+\.bytedance\.(com|net)|[\w-]+\.toutiao\.com|[\w-]+\.pstatp\.com|[\w-]+\.zijieapi\.com)\//i.test(urlStr);
  }

  /**
   * 从 aweme 对象中提取最佳播放地址
   * 优先级: play_addr > play_addr_h264 > play_addr_265 > bit_rate 最高码率
   */
  function resolvePlayUrl(aweme) {
    if (!aweme || !aweme.video) return '';

    const candidates = [];

    // play_addr
    const playAddr = aweme.video.play_addr;
    if (playAddr?.url_list?.length) {
      for (const url of playAddr.url_list) {
        if (url) candidates.push(normalizeVideoUrl(url));
      }
    }

    // play_addr_h264
    const h264 = aweme.video.play_addr_h264;
    if (h264?.url_list?.length) {
      for (const url of h264.url_list) {
        if (url) candidates.push(normalizeVideoUrl(url));
      }
    }

    // play_addr_265
    const h265 = aweme.video.play_addr_265;
    if (h265?.url_list?.length) {
      for (const url of h265.url_list) {
        if (url) candidates.push(normalizeVideoUrl(url));
      }
    }

    // bit_rate（按码率降序）
    if (Array.isArray(aweme.video.bit_rate)) {
      const sorted = [...aweme.video.bit_rate].sort((a, b) => (b?.bit_rate || 0) - (a?.bit_rate || 0));
      for (const item of sorted) {
        if (item?.play_addr?.url_list?.length) {
          for (const url of item.play_addr.url_list) {
            if (url) candidates.push(normalizeVideoUrl(url));
          }
        }
      }
    }

    // 过滤有效的 URL
    for (const url of candidates) {
      if (/^https?:\/\//i.test(url) && !/^https?:\/\/www\.douyin\.com\/?\?/i.test(url)) {
        return url;
      }
    }

    return candidates[0] || '';
  }

  // ========== aweme 数据提取与缓存 ==========

  function extractAwemeListFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.aweme_list)) return payload.aweme_list;
    if (payload.aweme_detail && typeof payload.aweme_detail === 'object') return [payload.aweme_detail];
    if (Array.isArray(payload.data)) {
      return payload.data
        .map((item) => item?.aweme || item?.aweme_detail || null)
        .filter((item) => item && typeof item === 'object');
    }
    if (Array.isArray(payload.cards)) {
      return payload.cards
        .map((item) => item?.aweme || item?.aweme_detail || null)
        .filter((item) => item && typeof item === 'object');
    }
    return [];
  }

  // 从 aweme 对象里捞视频自带字幕/CC 信息（少数视频有平台字幕）
  function extractCaptionsFromAweme(aweme) {
    const found = [];
    const candidates = [
      aweme?.video?.subtitle,
      aweme?.video?.subtitle_url,
      aweme?.video?.captions,
      aweme?.video?.caption_infos,
      aweme?.video?.cc,
      aweme?.subtitle,
      aweme?.video_info?.subtitle
    ];
    for (const c of candidates) {
      if (!c) continue;
      if (typeof c === 'string') {
        if (c) found.push({ url: c });
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (typeof item === 'string') {
            if (item) found.push({ url: item });
          } else if (item && typeof item === 'object') {
            const url = item?.url || item?.uri || item?.subtitle_url || item?.src || '';
            if (url) {
              found.push({
                url,
                language: item?.language || item?.lang || item?.language_code || '',
                format: item?.format || item?.type || ''
              });
            }
          }
        }
      } else if (typeof c === 'object') {
        const url = c?.url || c?.uri || c?.subtitle_url || c?.src || '';
        if (url) {
          found.push({
            url,
            language: c?.language || c?.lang || '',
            format: c?.format || c?.type || ''
          });
        }
      }
    }
    return found;
  }

  /**
   * 从 aweme 对象中提取统计数据（旺财嗅探关键数据）
   */
  function extractStatistics(aweme) {
    const stats = aweme?.statistics || {};
    return {
      digg_count: Number(stats.digg_count || stats.diggCount || 0),
      comment_count: Number(stats.comment_count || stats.commentCount || 0),
      share_count: Number(stats.share_count || stats.shareCount || 0),
      collect_count: Number(stats.collect_count || stats.collectCount || 0),
      play_count: Number(stats.play_count || stats.playCount || 0),
      download_count: Number(stats.download_count || stats.downloadCount || 0),
      forward_count: Number(stats.forward_count || stats.forwardCount || 0)
    };
  }

  /**
   * 从 aweme 对象中提取话题标签（旺财赛道判断关键数据）
   */
  function extractHashtags(aweme) {
    const tags = [];
    // 从 text_extra 提取（最可靠）
    if (Array.isArray(aweme?.text_extra)) {
      for (const item of aweme.text_extra) {
        if (item?.hashtag_name) {
          tags.push('#' + String(item.hashtag_name));
        }
      }
    }
    // 从 cha_list 提取（备用）
    if (Array.isArray(aweme?.cha_list)) {
      for (const cha of aweme.cha_list) {
        const name = String(cha?.cha_name || cha?.cid || '');
        if (name && !tags.includes('#' + name)) {
          tags.push('#' + name);
        }
      }
    }
    // 从 desc 正则提取（兜底）
    if (!tags.length && aweme?.desc) {
      const matches = String(aweme.desc).match(/#[^\s#]+/g);
      if (matches) {
        for (const m of matches) {
          if (!tags.includes(m)) tags.push(m);
        }
      }
    }
    return tags;
  }

  /**
   * 从 aweme 对象中提取完整作者信息
   */
  function extractAuthorDetail(aweme) {
    const author = aweme?.author || {};
    return {
      nickname: String(author.nickname || ''),
      uid: String(author.uid || ''),
      unique_id: String(author.unique_id || author.short_id || ''),
      sec_uid: String(author.sec_uid || ''),
      avatar_thumb: String(author.avatar_thumb?.url_list?.[0] || ''),
      follower_count: Number(author.follower_count || 0),
      following_count: Number(author.following_count || 0),
      total_favorited: Number(author.total_favorited || 0),
      signature: String(author.signature || ''),
      verification_type: Number(author.verification_type ?? -1),
      enterprise_verify_reason: String(author.enterprise_verify_reason || ''),
      custom_verify: String(author.custom_verify || ''),
      region: String(author.region || author.ip_location || '')
    };
  }

  /**
   * 从 aweme 对象中提取 BGM/音乐信息
   */
  function extractMusicInfo(aweme) {
    const music = aweme?.music || {};
    return {
      title: String(music.title || ''),
      author: String(music.author || ''),
      album: String(music.album || ''),
      duration: Number(music.duration || 0),
      id: String(music.id || music.mid || ''),
      is_original: !!music.is_original
    };
  }

  function extractCommentItemsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];

    // 直接匹配常见字段名
    if (Array.isArray(payload.comments) && payload.comments.length > 0) return payload.comments;
    if (Array.isArray(payload.comment_list) && payload.comment_list.length > 0) return payload.comment_list;
    if (Array.isArray(payload.data?.comments) && payload.data.comments.length > 0) return payload.data.comments;
    if (Array.isArray(payload.data?.comment_list) && payload.data.comment_list.length > 0) return payload.data.comment_list;

    // 深度探测：遍历顶层 key 查找数组类型且包含评论特征的字段
    const topKeys = Object.keys(payload);
    console.log('[VCPBridge][DEBUG] extractCommentItems payload keys:', topKeys.join(', '),
      'payloadPreview:', JSON.stringify(payload).slice(0, 300));

    for (const key of topKeys) {
      const val = payload[key];
      if (Array.isArray(val) && val.length > 0) {
        // 检查数组元素是否具有评论特征字段
        const first = val[0];
        if (first && typeof first === 'object' &&
            (first.cid || first.comment_id || first.text || first.content ||
             first.digg_count !== undefined || first.reply_comment_total !== undefined)) {
          console.log('[VCPBridge][DEBUG] 在字段', key, '中发现评论数组，长度:', val.length,
            '首项 keys:', Object.keys(first).slice(0, 10).join(', '));
          return val;
        }
      }
    }

    // 如果顶层没有，尝试在 data 子层级查找
    if (payload.data && typeof payload.data === 'object') {
      const dataKeys = Object.keys(payload.data);
      for (const key of dataKeys) {
        const val = payload.data[key];
        if (Array.isArray(val) && val.length > 0) {
          const first = val[0];
          if (first && typeof first === 'object' &&
              (first.cid || first.comment_id || first.text || first.content ||
               first.digg_count !== undefined || first.reply_comment_total !== undefined)) {
            console.log('[VCPBridge][DEBUG] 在 data.', key, '中发现评论数组，长度:', val.length);
            return val;
          }
        }
      }
    }

    return [];
  }

  function extractCommentUser(comment) {
    const user = comment?.user || comment?.comment_user_info || {};
    const genderMap = {
      0: 'unknown',
      1: 'male',
      2: 'female'
    };
    return {
      nickname: String(user.nickname || user.nick_name || ''),
      gender: String(genderMap[user.gender] || user.gender || ''),
      ip_location: String(comment?.ip_label || comment?.ip_location || user.ip_location || ''),
      uid: String(user.uid || user.sec_uid || user.short_id || '')
    };
  }

  function extractCommentEntry(comment) {
    // 抖音主评论的 reply_id 和 reply_to_comment_id 都可能为 "0" 或 0
    // 这些都应视为 null（主评论），只有真正非零值才表示子评论
    const rawReplyToId = comment?.reply_to_comment_id;
    const rawReplyId = comment?.reply_id;
    const rawReplyToReplyId = comment?.reply_to_reply_id;

    // 统一处理：将 "0"、0、""、null、undefined 都归为 null
    const normalizeReplyField = (val) => {
      if (val === null || val === undefined || val === '' || val === '0' || val === 0) return null;
      return String(val);
    };

    const replyToCommentId = normalizeReplyField(rawReplyToId) || normalizeReplyField(rawReplyId);
    // reply_to_reply_id 用于标识三级回复（本项目暂不需要，但为兼容性保留）

    return {
      cid: String(comment?.cid || comment?.comment_id || ''),
      content: String(comment?.text || comment?.content || '').trim(),
      likes: Number(comment?.digg_count || comment?.like_count || 0),
      reply_count: Number(comment?.reply_comment_total || comment?.reply_count || 0),
      create_time: Number(comment?.create_time || 0),
      reply_to_comment_id: replyToCommentId, // null = 主评论，非 null = 子评论
      user: extractCommentUser(comment)
    };
  }

  function mergeKeywordSummary(existing = [], incoming = []) {
    const merged = new Map();
    for (const item of [...existing, ...incoming]) {
      const word = String(item?.word || '').trim();
      if (!word) continue;
      const prev = merged.get(word) || { word, count: 0 };
      prev.count += Number(item?.count || 0);
      merged.set(word, prev);
    }
    return Array.from(merged.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }

  function buildCommentKeywordSummary(comments = []) {
    const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '啊', '呀', '吧', '吗', '呢', '就', '都', '也', '很', '还', '一个', '这个', '那个', '真的', '不是', '就是', '可以', '还是', '什么']);
    const freq = new Map();
    for (const comment of comments) {
      const text = String(comment?.content || '');
      const matches = text.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_]{3,}/g) || [];
      for (const token of matches) {
        const word = String(token).trim().toLowerCase();
        if (!word || stopWords.has(word)) continue;
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }

  /**
   * 瘦身评论数据，防止 Chrome 扩展消息通道序列化崩溃
   * 只保留旺财需要的核心字段，限制字符串和数组长度
   */
  function sanitizeCommentForTransfer(comment) {
    return {
      cid: String(comment?.cid || '').slice(0, 50),
      content: String(comment?.content || '').slice(0, 500),
      likes: Number(comment?.likes || 0),
      user: {
        nickname: String(comment?.user?.nickname || '').slice(0, 50),
        uid: String(comment?.user?.uid || '').slice(0, 50)
      }
    };
  }

  function cacheCommentFromPayload(payload, source = 'unknown', requestUrl = '') {
    // 强制打印，看是否收到了 payload 但没提取出 ID
    console.log('[VCPBridge][DEBUG] cacheCommentFromPayload incoming:', source, requestUrl);

    let parsedAwemeId = '';
    try {
        if (requestUrl) {
           const parsedUrl = new URL(requestUrl, window.location.origin);
           parsedAwemeId = parsedUrl.searchParams.get('aweme_id') || parsedUrl.searchParams.get('item_id') || '';
        }
    } catch(e) {}

    const rawComments = extractCommentItemsFromPayload(payload);

    console.log('[VCPBridge][DEBUG] rawComments 提取结果:', {
      count: rawComments.length,
      firstItem: rawComments.length > 0 ? JSON.stringify(rawComments[0]).slice(0, 300) : 'N/A',
      firstItemKeys: rawComments.length > 0 ? Object.keys(rawComments[0]).slice(0, 15).join(', ') : 'N/A'
    });

    // 终极提取方案：如果在顶层找不到 aweme_id，尝试在第一条评论中提取
    let fallbackAwemeId = '';
    if (rawComments && rawComments.length > 0) {
        fallbackAwemeId = rawComments[0]?.aweme_id || rawComments[0]?.item_id || '';
    }

    const awemeId = String(
      payload?.aweme_id ||
      payload?.awemeId ||
      payload?.group_id ||
      payload?.item_id ||
      parsedAwemeId ||
      fallbackAwemeId ||
      ''
    ).trim();

    if (!awemeId) {
       console.log('[VCPBridge][DEBUG] 无法从 payload 或 url 提取 awemeId，跳过缓存。url:', requestUrl, 'payloadPreview:', JSON.stringify(payload).slice(0, 100));
       return 0;
    }
    const parsedComments = rawComments
      .map(extractCommentEntry)
      .filter((item) => item.content);

    console.log('[VCPBridge][DEBUG] parsedComments (extractCommentEntry 后):', {
      rawCount: rawComments.length,
      parsedCount: parsedComments.length,
      firstParsed: parsedComments.length > 0 ? JSON.stringify(parsedComments[0]).slice(0, 200) : 'N/A'
    });

    const existing = commentCache.get(awemeId);
    const mergedByCid = new Map();
    for (const item of existing?.hot_comments || []) {
      const key = String(item?.cid || item?.content || '');
      if (key) mergedByCid.set(key, item);
    }
    for (const item of parsedComments) {
      const key = String(item?.cid || item?.content || '');
      if (key) mergedByCid.set(key, item);
    }

    const mergedComments = Array.from(mergedByCid.values())
      .filter((item) => !item.reply_to_comment_id) // 只保留主评论（排除子评论/回复）
      .sort((a, b) => (b.likes || 0) - (a.likes || 0)) // 按点赞数降序排序
      .slice(0, 20); // 只保留点赞最高的 20 条

    const totalCount = Number(
      payload?.total ||
      payload?.total_count ||
      payload?.comment_count ||
      payload?.comments_total ||
      existing?.total_count ||
      mergedComments.length ||
      0
    );

    const keywordsSummary = mergeKeywordSummary(
      existing?.keywords_summary || [],
      buildCommentKeywordSummary(mergedComments)
    );

    commentCache.set(awemeId, {
      aweme_id: awemeId,
      total_count: totalCount,
      hot_comments: mergedComments,
      keywords_summary: keywordsSummary,
      source,
      cached_at: new Date().toISOString()
    });

    if (commentCache.size > MAX_COMMENT_CACHE_SIZE) {
      const keys = Array.from(commentCache.keys());
      const toRemove = keys.slice(0, keys.length - MAX_COMMENT_CACHE_SIZE);
      for (const key of toRemove) {
        commentCache.delete(key);
      }
    }

    console.log('[VCPBridge][MAIN] 已缓存评论数据:', {
      awemeId,
      source,
      totalCount,
      cachedComments: mergedComments.length,
      cacheSize: commentCache.size
    });

    return mergedComments.length;
  }

  function cacheAwemeFromPayload(payload, source = 'unknown') {
    const awemeList = extractAwemeListFromPayload(payload);
    let count = 0;

    for (const aweme of awemeList) {
      const awemeId = String(aweme?.aweme_id || aweme?.awemeId || aweme?.group_id || '').trim();
      if (!awemeId) continue;

      const playUrl = resolvePlayUrl(aweme);
      const desc = String(aweme?.desc || '').trim();
      const authorName = String(aweme?.author?.nickname || '').trim();

      // 收集所有可用的播放地址（纯字符串数组）
      const allPlayUrls = [];
      if (aweme?.video?.play_addr?.url_list) {
        for (const u of aweme.video.play_addr.url_list) {
          if (u) allPlayUrls.push(normalizeVideoUrl(u));
        }
      }
      if (aweme?.video?.play_addr_h264?.url_list) {
        for (const u of aweme.video.play_addr_h264.url_list) {
          if (u) allPlayUrls.push(normalizeVideoUrl(u));
        }
      }

      // ===== 旺财嗅探增强数据 =====
      const statistics = extractStatistics(aweme);
      const hashtags = extractHashtags(aweme);
      const authorDetail = extractAuthorDetail(aweme);
      const musicInfo = extractMusicInfo(aweme);
      const duration = Number(aweme?.video?.duration || aweme?.duration || 0);
      const createTime = Number(aweme?.create_time || 0);
      const videoWidth = Number(aweme?.video?.width || aweme?.video?.play_addr?.width || 0);
      const videoHeight = Number(aweme?.video?.height || aweme?.video?.play_addr?.height || 0);
      const shareUrl = String(aweme?.share_url || aweme?.share_info?.share_url || '');
      const ipLocation = String(aweme?.ip_label || '');
      const isAd = !!(aweme?.is_ads || aweme?.cell_type === 1);
      // 视频自带字幕/CC（少数视频有）
      const captions = extractCaptionsFromAweme(aweme);

      awemeCache.set(awemeId, {
        aweme_id: awemeId,
        play_url: playUrl,
        all_play_urls: allPlayUrls,
        desc: desc,
        author_name: authorName,
        // 旺财嗅探增强数据
        statistics: statistics,
        hashtags: hashtags,
        author: authorDetail,
        music: musicInfo,
        duration: duration,
        create_time: createTime,
        video_width: videoWidth,
        video_height: videoHeight,
        share_url: shareUrl,
        ip_location: ipLocation,
        is_ad: isAd,
        captions: captions,
        source: source,
        cached_at: new Date().toISOString()
      });
      count += 1;
    }

    // 限制缓存大小
    if (awemeCache.size > MAX_CACHE_SIZE) {
      const keys = Array.from(awemeCache.keys());
      const toRemove = keys.slice(0, keys.length - MAX_CACHE_SIZE);
      for (const key of toRemove) {
        awemeCache.delete(key);
      }
    }

    if (count > 0) {
      console.log('[VCPBridge][MAIN] 已缓存 aweme 数据:', {
        source,
        count,
        cacheSize: awemeCache.size
      });
    }
    return count;
  }

  // ========== XHR/Fetch 拦截 ==========
  // v1.6.0: 参考智小抖（精确 URL 匹配）和社媒（ReadableStream 读取）的成功实现

  function instrumentAwemeApiCaching() {
    if (window.__VCPBRIDGE_AWEME_CACHE_INSTRUMENTED__) return;
    window.__VCPBRIDGE_AWEME_CACHE_INSTRUMENTED__ = true;

    // 获取绝对路径
    function getAbsoluteUrl(urlStr) {
      if (!urlStr) return '';
      try {
        return new URL(urlStr, window.location.origin).href;
      } catch {
        return urlStr;
      }
    }

    // 安全 JSON 解析（参考社媒 bt() 函数）
    function safeJsonParse(text) {
      if (!text || typeof text !== 'string') return null;
      const trimmed = text.trim();
      // 快速检查：是否看起来像 JSON
      if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
          !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        return null;
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }

    // 处理拦截到的数据（XHR 和 fetch 共用）
    function processInterceptedData(url, payload, source) {
      if (!payload || typeof payload !== 'object') return;
      try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;

        // 缓存签名参数（用于后续 prewarm）
        cacheSignParams(url);

        // 视频/推荐流数据缓存
        cacheAwemeFromPayload(payload, `${source}:${pathname}`);

        // 直播弹幕（IM 长轮询）缓存 —— 实验性
        cacheDanmakuFromPayload(payload, url);

        // 评论数据缓存 —— 精确路径匹配（参考智小抖 DyApiMap）
        if (isCommentApiUrl(url)) {
          console.log('[VCPBridge][MAIN] 拦截到评论 API:', { source, pathname, url: url.slice(0, 120) });
          cacheCommentFromPayload(payload, `${source}:${pathname}`, url);
        }
        // 兜底：payload 中包含评论字段（但排除回复评论 URL）
        else if (hasCommentPayload(payload) && !isCommentReplyUrl(url)) {
          console.log('[VCPBridge][MAIN] payload 兜底匹配到评论数据:', { source, pathname });
          cacheCommentFromPayload(payload, `${source}_payload_match:${pathname}`, url);
        }
      } catch (e) {
        console.warn('[VCPBridge][MAIN] processInterceptedData 错误:', e?.message || e);
      }
    }

    // ===== Hook XMLHttpRequest =====
    // 参考智小抖：替换 open 记录 method+url，替换 send 添加 onreadystatechange
    // 参考社媒：检查 content-type 和 responseText 有效性
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (...args) {
      this.__vcpbridge_method__ = args?.[0] || 'GET';
      this.__vcpbridge_url__ = args?.[1] || '';
      return originalOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      // 保存原始 onreadystatechange（参考智小抖方式）
      const origOnRsc = this.onreadystatechange;
      let handled = false;

      this.onreadystatechange = function () {
        if (!handled && this.readyState === 4 && this.status === 200) {
          handled = true;
          let url = this.responseURL || this.__vcpbridge_url__ || '';
          url = getAbsoluteUrl(url);

          if (isDouyinApiUrl(url)) {
            try {
              // 检查 content-type（参考社媒 da() 函数）
              const ct = this.getResponseHeader('content-type') || '';
              if (ct.includes('application/json') || !ct || ct.includes('text/')) {
                // 放宽 responseType 限制：允许 '', 'text', 'json' 以及未设置的情况
                let payload = null;
                if (this.responseType === 'json') {
                  payload = this.response;
                } else if (!this.responseType || this.responseType === 'text' || this.responseType === '') {
                  payload = safeJsonParse(this.responseText);
                }
                if (payload) {
                  processInterceptedData(url, payload, 'xhr');
                }
              }
            } catch (e) {
              // 静默忽略
            }
          }
        }
        if (typeof origOnRsc === 'function') {
          origOnRsc.apply(this, arguments);
        }
      };

      // 同时保留 addEventListener 方式作为双保险
      this.addEventListener('load', function () {
        if (handled) return; // 已经在 onreadystatechange 中处理过
        handled = true;
        let url = this.responseURL || this.__vcpbridge_url__ || '';
        url = getAbsoluteUrl(url);
        if (!isDouyinApiUrl(url)) return;
        try {
          let payload = null;
          if (this.responseType === 'json') {
            payload = this.response;
          } else if (!this.responseType || this.responseType === 'text' || this.responseType === '') {
            payload = safeJsonParse(this.responseText);
          }
          if (payload) {
            processInterceptedData(url, payload, 'xhr_load');
          }
        } catch {}
      });

      return originalSend.apply(this, args);
    };

    // ===== Hook fetch =====
    // v1.6.0: 改用 .text() + JSON.parse（参考智小抖），
    // 对特殊流式 URL 使用 ReadableStream 逐块读取（参考社媒）
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        let requestUrl =
          typeof args?.[0] === 'string'
            ? args[0]
            : args?.[0]?.url || '';

        requestUrl = getAbsoluteUrl(requestUrl);

        if (isDouyinApiUrl(requestUrl) && response.ok) {
          const cloned = response.clone();

          // 异步处理，不阻塞原始 response 返回
          (async () => {
            try {
              let text = '';

              // 对搜索流式接口使用 ReadableStream（参考社媒 ha() 函数）
              if (requestUrl.includes('/search/stream/')) {
                const reader = cloned.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let chunks = '';
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  chunks += decoder.decode(value, { stream: true });
                }
                chunks += decoder.decode();
                text = chunks;
              } else {
                // 标准接口使用 .text()（参考智小抖 injectFetch）
                // 而不是 .json()，避免非标准 JSON 静默失败
                text = await cloned.text();
              }

              const payload = safeJsonParse(text);
              if (payload) {
                processInterceptedData(requestUrl, payload, 'fetch');
              }
            } catch (e) {
              // 仅在评论 URL 时打印警告，其他静默
              if (isCommentApiUrl(requestUrl)) {
                console.warn('[VCPBridge][MAIN] fetch 评论数据解析失败:', {
                  url: requestUrl.slice(0, 120),
                  error: e?.message || e
                });
              }
            }
          })();
        }
      } catch {}
      return response;
    };

    console.log('[VCPBridge][MAIN] XHR/Fetch 拦截已安装 v1.6.0 (精确评论匹配 + ReadableStream + 签名缓存)');
  }

  // ========== 预热请求 ==========

  async function prewarmAwemeDetailRequest(awemeId, sourceUrl) {
    if (!awemeId) {
      throw new Error('主世界预热缺少 awemeId');
    }

    const apiUrls = [
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}&aid=6383&channel=channel_pc_web&device_platform=webapp&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=134.0.0.0&browser_online=true&engine_name=Blink&engine_version=134.0.0.0&os_name=Windows&os_version=10&cpu_core_num=8&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50`,
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}&aid=1128&version_name=23.5.0&device_platform=android&os_version=2333`
    ];

    let lastError = '';
    for (const apiUrl of apiUrls) {
      try {
        const resp = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*'
          }
        });
        if (!resp.ok) {
          lastError = `HTTP ${resp.status}`;
          continue;
        }

        const text = await resp.text();
        if (!text || !text.trim()) {
          lastError = 'empty response';
          continue;
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          lastError = `non-json response: ${text.slice(0, 80)}`;
          continue;
        }

        const aweme = json?.aweme_detail || null;
        const playUrl = resolvePlayUrl(aweme);
        const desc = aweme?.desc ? String(aweme.desc) : '';
        const authorName = aweme?.author?.nickname ? String(aweme.author.nickname) : '';

        console.log('[VCPBridge][MAIN] aweme detail 预热请求成功:', {
          awemeId,
          apiUrl: apiUrl.slice(0, 140),
          hasAweme: !!aweme,
          hasPlayUrl: !!playUrl
        });

        return {
          status: 'ok',
          url: apiUrl,
          play_url: playUrl,
          desc,
          author_name: authorName,
          has_aweme_detail: !!aweme
        };
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }

    const targetUrl = sourceUrl && /^https?:\/\//i.test(sourceUrl)
      ? sourceUrl
      : `https://www.douyin.com/video/${awemeId}`;

    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        credentials: 'include'
      });
      if (resp.ok) {
        console.log('[VCPBridge][MAIN] 页面级预热已完成:', targetUrl);
        return { status: 'page_warmup_only', url: targetUrl, play_url: '', desc: '', author_name: '', has_aweme_detail: false };
      }
      lastError = `page warmup HTTP ${resp.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }

    throw new Error(lastError || '主世界预热请求失败');
  }

  // ========== 评论预热请求 ==========
  // v1.6.0: 加入签名参数重用（参考"1"插件 qi() 函数的重试+签名缓存机制）

  async function prewarmCommentRequest(awemeId) {
    if (!awemeId) {
      throw new Error('评论预热缺少 awemeId');
    }

    // 基础 URL（不含签名参数，签名参数从缓存中获取）
    const baseUrl = `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${encodeURIComponent(awemeId)}&cursor=0&count=20&aid=6383&channel=channel_pc_web&device_platform=webapp&pc_client_type=1&version_code=190500&version_name=19.5.0`;

    // 最多重试 3 次（参考"1"插件最多 10 次）
    const MAX_RETRIES = 3;
    let lastError = '';

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 尝试从缓存获取签名参数并附加到 URL
        const signParams = getLatestSignParams();
        const apiUrl = applySignParams(baseUrl, signParams);

        console.log('[VCPBridge][MAIN] 评论预热尝试:', {
          awemeId,
          attempt: attempt + 1,
          hasSignParams: !!signParams,
          signParamKeys: signParams ? Array.from(signParams.keys()).join(',') : 'none',
          url: apiUrl.slice(0, 150)
        });

        const resp = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'referer': `https://www.douyin.com/video/${awemeId}`
          }
        });

        if (!resp.ok) {
          lastError = `HTTP ${resp.status}`;
          console.warn('[VCPBridge][MAIN] 评论预热 HTTP 失败:', { awemeId, status: resp.status, attempt: attempt + 1 });
          // 如果是签名失败（403/400），清除可能过期的签名参数
          if (resp.status === 403 || resp.status === 400) {
            if (signParamCache.length > 0) signParamCache.pop();
          }
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const text = await resp.text();
        if (!text || !text.trim()) {
          lastError = 'empty response';
          console.warn('[VCPBridge][MAIN] 评论预热响应为空:', { awemeId, attempt: attempt + 1 });
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          lastError = `non-json response: ${text.slice(0, 80)}`;
          console.warn('[VCPBridge][MAIN] 评论预热响应非 JSON:', { awemeId, text: text.slice(0, 100) });
          continue;
        }

        // 检查 API 业务状态码
        if (json.status_code !== undefined && json.status_code !== 0) {
          lastError = `API status_code: ${json.status_code}`;
          console.warn('[VCPBridge][MAIN] 评论预热 API 业务失败:', {
            awemeId,
            statusCode: json.status_code,
            statusMsg: json.status_msg || '',
            attempt: attempt + 1
          });
          // 可能是签名参数过期
          if (signParamCache.length > 0) signParamCache.pop();
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        console.log('[VCPBridge][MAIN] 评论预热 API 响应结构:', {
          awemeId,
          hasComments: !!json?.comments,
          hasCommentList: !!json?.comment_list,
          hasDataComments: !!json?.data?.comments,
          total: json?.total,
          totalCount: json?.total_count,
          statusCode: json?.status_code,
          responseKeys: Object.keys(json || {}).slice(0, 15).join(', ')
        });

        // 调用现有的缓存函数处理评论数据
        const cachedCount = cacheCommentFromPayload(json, `prewarm:attempt${attempt + 1}`, apiUrl);

        console.log('[VCPBridge][MAIN] 评论预热请求成功:', {
          awemeId,
          attempt: attempt + 1,
          cachedCount,
          totalCount: json?.total || json?.total_count || 0
        });

        return {
          status: 'ok',
          url: apiUrl,
          cached_count: cachedCount,
          total_count: json?.total || json?.total_count || 0
        };
      } catch (error) {
        lastError = error?.message || String(error);
        console.warn('[VCPBridge][MAIN] 评论预热异常:', { awemeId, attempt: attempt + 1, error: lastError });
        await new Promise(r => setTimeout(r, 200));
      }
    }

    throw new Error(lastError || '评论预热请求失败（已重试 ' + MAX_RETRIES + ' 次）');
  }

  // ========== 启动拦截 ==========

  instrumentAwemeApiCaching();

  // ========== 事件监听：缓存查询 ==========
  // 内容脚本通过 CustomEvent 查询缓存
  // 响应只包含纯字符串，绝对不含复杂对象

  window.addEventListener(CACHE_REQUEST_EVENT, (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';
    const awemeId = String(detail.awemeId || '').trim();

    const cached = awemeId ? awemeCache.get(awemeId) : null;

    // 只返回纯字符串和简单对象！
    window.postMessage({
      source: 'VCPBridge',
      type: CACHE_RESPONSE_EVENT,
      requestId,
      success: !!cached,
      play_url: cached?.play_url || '',
      desc: cached?.desc || '',
      author_name: cached?.author_name || '',
      source_info: cached?.source || '',
      all_play_urls: cached?.all_play_urls || [],
      captions: cached?.captions || [],
      // 旺财嗅探增强数据
      statistics: cached?.statistics || null,
      hashtags: cached?.hashtags || [],
      author: cached?.author || null,
      music: cached?.music || null,
      duration: cached?.duration || 0,
      create_time: cached?.create_time || 0,
      video_width: cached?.video_width || 0,
      video_height: cached?.video_height || 0,
      share_url: cached?.share_url || '',
      ip_location: cached?.ip_location || '',
      is_ad: cached?.is_ad || false
    }, window.location.origin);
  }, false);

  window.addEventListener(COMMENT_CACHE_REQUEST_EVENT, (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';
    const awemeId = String(detail.awemeId || '').trim();

    const cached = awemeId ? commentCache.get(awemeId) : null;

    window.postMessage({
      source: 'VCPBridge',
      type: COMMENT_CACHE_RESPONSE_EVENT,
      requestId,
      success: !!cached,
      total_count: cached?.total_count || 0,
      hot_comments: (cached?.hot_comments || []).slice(0, 200).map(sanitizeCommentForTransfer),
      keywords_summary: (cached?.keywords_summary || []).slice(0, 10),
      source_info: cached?.source || '',
      cached_at: cached?.cached_at || ''
    }, window.location.origin);
  }, false);

  // ========== 事件监听：预热请求 ==========

  window.addEventListener(PREWARM_REQUEST_EVENT, async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';
    const awemeId = detail.awemeId || '';
    const sourceUrl = detail.sourceUrl || '';

    try {
      const result = await prewarmAwemeDetailRequest(awemeId, sourceUrl);
      window.postMessage({
        source: 'VCPBridge',
        type: PREWARM_RESPONSE_EVENT,
        requestId,
        success: true,
        status: result.status || 'ok',
        url: result.url || '',
        play_url: result.play_url || '',
        desc: result.desc || '',
        author_name: result.author_name || '',
        has_aweme_detail: !!result.has_aweme_detail
      }, window.location.origin);
    } catch (error) {
      console.warn('[VCPBridge][MAIN] aweme detail 预热失败:', awemeId, error?.message || error);
      window.postMessage({
        source: 'VCPBridge',
        type: PREWARM_RESPONSE_EVENT,
        requestId,
        success: false,
        error: error?.message || '主世界预热请求失败'
      }, window.location.origin);
    }
  }, false);

  // ========== 事件监听：评论预热请求 ==========

  window.addEventListener(COMMENT_PREWARM_REQUEST_EVENT, async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';
    const awemeId = detail.awemeId || '';

    try {
      const result = await prewarmCommentRequest(awemeId);
      window.postMessage({
        source: 'VCPBridge',
        type: COMMENT_PREWARM_RESPONSE_EVENT,
        requestId,
        success: true,
        status: result.status || 'ok',
        url: result.url || '',
        cached_count: result.cached_count || 0,
        total_count: result.total_count || 0
      }, window.location.origin);
    } catch (error) {
      console.warn('[VCPBridge][MAIN] 评论预热失败:', awemeId, error?.message || error);
      window.postMessage({
        source: 'VCPBridge',
        type: COMMENT_PREWARM_RESPONSE_EVENT,
        requestId,
        success: false,
        error: error?.message || '评论预热请求失败'
      }, window.location.origin);
    }
  }, false);

  // ========== 直播弹幕缓存（实验性） ==========

  const DANMAKU_CACHE_REQUEST_EVENT = 'VCPBRIDGE_DOUYIN_DANMAKU_CACHE_REQUEST';
  const DANMAKU_CACHE_RESPONSE_EVENT = 'VCPBRIDGE_DOUYIN_DANMAKU_CACHE_RESPONSE';
  const danmakuCache = [];
  const MAX_DANMAKU_CACHE = 500;

  function extractRoomIdFromUrl(url = '') {
    const roomMatch = String(url || '').match(/room[_-]?id[=/](\d+)/i) ||
                      String(url || '').match(/\/live\/(\d+)/i);
    return roomMatch ? roomMatch[1] : '';
  }

  // 启发式解码 protobuf 弹幕 payload（base64），提取其中看起来像中文消息的片段
  function decodeDanmakuPayloadText(base64Payload) {
    if (!base64Payload || typeof base64Payload !== 'string') return '';
    try {
      const binary = atob(base64Payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const segments = text.match(/[\u4e00-\u9fa5][\u4e00-\u9fa5\w\s，。！？、…“”‘’：；·~!?.,;:'"()（）\-—]{1,60}/g);
      if (!segments) return '';
      return segments
        .map((s) => s.trim())
        .filter((s) => s.length >= 2)
        .sort((a, b) => b.length - a.length)[0] || '';
    } catch (_) {
      return '';
    }
  }

  function extractLiveMessagesFromPayload(payload, url = '') {
    const messages = [];
    if (!payload || typeof payload !== 'object') return messages;
    const list = payload?.data?.messages || payload?.messages || [];
    if (!Array.isArray(list)) return messages;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const content = String(
        m?.content ||
        m?.message ||
        m?.text ||
        m?.common?.content ||
        m?.data?.content ||
        decodeDanmakuPayloadText(m?.payload) ||
        ''
      ).trim();
      if (!content) continue;
      messages.push({
        roomId: String(m?.room_id || m?.common?.room_id || extractRoomIdFromUrl(url) || 'unknown'),
        nickname: String(m?.user?.nickname || m?.nickname || m?.common?.user?.nickname || ''),
        content: content.slice(0, 200),
        create_time: Number(m?.create_time || m?.timestamp || m?.common?.create_time || 0)
      });
    }
    return messages;
  }

  function pushDanmakuMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const m of messages) {
      danmakuCache.push({ ...m, captured_at: new Date().toISOString() });
    }
    if (danmakuCache.length > MAX_DANMAKU_CACHE) {
      danmakuCache.splice(0, danmakuCache.length - MAX_DANMAKU_CACHE);
    }
  }

  // 拦截直播 IM 长轮询（/webcast/im/fetch/ 等）里的弹幕
  function cacheDanmakuFromPayload(payload, url) {
    try {
      const pathname = new URL(url).pathname;
      if (!/webcast/i.test(pathname)) return;
      pushDanmakuMessages(extractLiveMessagesFromPayload(payload, url));
    } catch (_) { /* ignore */ }
  }

  // 拦截 WebSocket（直播弹幕走 wss://live.douyin.com/webcast/...）
  function hookLiveWebSocket() {
    if (window.__vcpLiveWsHooked) return;
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket !== 'function') return;

    function PatchedWebSocket(...args) {
      const ws = new OriginalWebSocket(...args);
      try {
        const url = String(args[0] || '');
        if (/live\.douyin\.com|webcast/i.test(url)) {
          ws.addEventListener('message', (event) => {
            try {
              const raw = typeof event.data === 'string' ? event.data : '';
              const payload = safeJsonParse(raw);
              if (!payload) return;
              pushDanmakuMessages(extractLiveMessagesFromPayload(payload, url));
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return ws;
    }

    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    for (const key of Object.getOwnPropertyNames(OriginalWebSocket)) {
      try {
        if (!(key in PatchedWebSocket)) PatchedWebSocket[key] = OriginalWebSocket[key];
      } catch (_) { /* ignore */ }
    }
    window.WebSocket = PatchedWebSocket;
    window.__vcpLiveWsHooked = true;
  }

  window.addEventListener(DANMAKU_CACHE_REQUEST_EVENT, (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';
    const limit = Math.min(Number(detail.limit) || 200, MAX_DANMAKU_CACHE);
    const recent = danmakuCache.slice(-limit);
    window.postMessage({
      source: 'VCPBridge',
      type: DANMAKU_CACHE_RESPONSE_EVENT,
      requestId,
      success: recent.length > 0,
      count: recent.length,
      room_ids: Array.from(new Set(recent.map((m) => String(m.roomId || '')))).filter(Boolean).slice(0, 5),
      messages: recent.map((m) => ({
        room_id: String(m.roomId || ''),
        nickname: String(m.nickname || '').slice(0, 50),
        content: String(m.content || '').slice(0, 200),
        create_time: Number(m.create_time || 0),
        captured_at: String(m.captured_at || '')
      }))
    }, window.location.origin);
  }, false);

  hookLiveWebSocket();

  // ========== 事件监听：查询最近缓存的 aweme（推荐流兜底） ==========

  window.addEventListener(RECENT_CACHE_REQUEST_EVENT, (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId || '';

    // 查找最近缓存的 aweme（按 cached_at 时间排序取最新的）
    let latestEntry = null;
    let latestTime = '';

    for (const [id, entry] of awemeCache.entries()) {
      if (entry.cached_at && entry.cached_at > latestTime) {
        latestTime = entry.cached_at;
        latestEntry = entry;
      }
    }

    window.postMessage({
      source: 'VCPBridge',
      type: RECENT_CACHE_RESPONSE_EVENT,
      requestId,
      success: !!latestEntry,
      aweme_id: latestEntry?.aweme_id || '',
      play_url: latestEntry?.play_url || '',
      desc: latestEntry?.desc || '',
      author_name: latestEntry?.author_name || '',
      source_info: latestEntry?.source || '',
      all_play_urls: latestEntry?.all_play_urls || [],
      captions: latestEntry?.captions || [],
      statistics: latestEntry?.statistics || null,
      hashtags: latestEntry?.hashtags || [],
      author: latestEntry?.author || null,
      music: latestEntry?.music || null,
      duration: latestEntry?.duration || 0,
      create_time: latestEntry?.create_time || 0,
      video_width: latestEntry?.video_width || 0,
      video_height: latestEntry?.video_height || 0,
      share_url: latestEntry?.share_url || '',
      ip_location: latestEntry?.ip_location || '',
      is_ad: latestEntry?.is_ad || false,
      cache_size: awemeCache.size
    }, window.location.origin);
  }, false);

  console.log('[VCPBridge][MAIN] 抖音主世界脚本已加载 v1.7.0 - 推荐流投喂增强 + 直播弹幕捕获');
})();
