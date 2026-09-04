'use strict';

/**
 * 日记结构化标记提取器：从日记正文里抽出 `[场景::厨房]` `[在场::可可,微明]` 这类标记。
 *
 * **纯正则，绝不调用 LLM。** 这是硬约束，不是性能取舍：
 * 写日记是 Agent 自我决定的行为，如果提取环节要过一次模型，
 * 就等于「有人写了日记」隐式唤醒了一次推理 —— 那正是本设计要避免的主动唤醒。
 * 标记由写日记的 Agent 自己按格式写下，读取侧只做机械解析。
 *
 * 解析失败一律降级为「没有标记」而非抛错：标记是可选的富化信息，
 * 一个写歪的括号不该让整篇日记的投影进 dead_letter（见实施报告 5.1.1 失败形态）。
 */

// 半角/全角括号都接受：中文输入法默认给全角「［］」，而 Agent 提示词里写的是半角。
// 两种都出现过，只认一种会让另一种静默失效 —— 这类静默失效最难排查。
const MARKER_REGEX = /[[［]\s*([^[\]［］:：]{1,32}?)\s*(?:::|：：)\s*([^[\]［］]{0,256}?)\s*[\]］]/g;

// 键名同时接受简繁：`[在場::小絕]` 与 `[在场::可可]` 都得认。
const KEY_ALIASES = new Map([
    ['场景', 'scene'], ['場景', 'scene'], ['scene', 'scene'],
    ['在场', 'present'], ['在場', 'present'], ['present', 'present'],
    ['情绪', 'mood'], ['情緒', 'mood'], ['mood', 'mood'],
    ['话题', 'topic'], ['話題', 'topic'], ['topic', 'topic']
]);

// 列表分隔符含全角逗号与顿号：中文里「可可、微明」比「可可,微明」更自然。
const LIST_SEPARATOR = /[,，、;；\s]+/;

const EMPTY = Object.freeze({ scene: null, present: Object.freeze([]), mood: null, topic: null, raw: Object.freeze({}) });

function splitList(value) {
    return [...new Set(String(value).split(LIST_SEPARATOR).map(item => item.trim()).filter(Boolean))];
}

/**
 * @param {string} text 日记正文（生命周期事件的 content.text）
 * @returns {{scene: string|null, present: string[], mood: string|null, topic: string|null, raw: object}}
 */
function extractDiaryMarkers(text) {
    const source = String(text || '');
    if (!source) return EMPTY;

    const raw = {};
    const present = [];
    let scene = null;
    let mood = null;
    let topic = null;

    // 每次新建正则实例：MARKER_REGEX 带 /g，共用实例会因 lastIndex 残留漏掉标记。
    for (const match of source.matchAll(new RegExp(MARKER_REGEX.source, 'g'))) {
        const rawKey = match[1].trim();
        const rawValue = match[2].trim();
        if (!rawKey) continue;
        raw[rawKey] = rawValue;

        switch (KEY_ALIASES.get(rawKey)) {
            case 'present':
                present.push(...splitList(rawValue));
                break;
            // 同一篇里重复出现取第一个：日记是时序文本，靠前的是本篇的主场景，
            // 靠后的往往是引述别的场合。
            case 'scene': if (scene === null && rawValue) scene = rawValue; break;
            case 'mood': if (mood === null && rawValue) mood = rawValue; break;
            case 'topic': if (topic === null && rawValue) topic = rawValue; break;
            default: break;
        }
    }

    return { scene, present: [...new Set(present)], mood, topic, raw };
}

function hasDiaryMarkers(text) {
    return new RegExp(MARKER_REGEX.source).test(String(text || ''));
}

module.exports = { extractDiaryMarkers, hasDiaryMarkers, MARKER_REGEX, KEY_ALIASES };
