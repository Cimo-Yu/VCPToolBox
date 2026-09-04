'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractDiaryMarkers, hasDiaryMarkers } = require('../extensions/memory-river/DiaryMarkerExtractor');

test('extracts scene and present list from a diary entry', () => {
    const markers = extractDiaryMarkers('[2026-07-26] [场景::厨房] [在场::小绝,可可]\n\n汤咸了。');
    assert.equal(markers.scene, '厨房');
    assert.deepEqual(markers.present, ['小绝', '可可']);
    // 日期本身不是 `键::值` 形状，不应被误认成标记。
    assert.equal(markers.raw['2026-07-26'], undefined);
});

test('accepts full-width brackets, separators and traditional keys', () => {
    // 中文输入法默认给全角括号与顿号；只认半角会让这半数写法静默失效。
    const markers = extractDiaryMarkers('［場景：：走廊］［在場：：小絕、微明］');
    assert.equal(markers.scene, '走廊');
    assert.deepEqual(markers.present, ['小絕', '微明']);
});

test('keeps the first value when a key repeats', () => {
    // 日记是时序文本：靠前的是本篇场景，靠后的多是引述别的场合。
    const markers = extractDiaryMarkers('[场景::厨房] 后来说起 [场景::天台] 的事。');
    assert.equal(markers.scene, '厨房');
    assert.equal(markers.raw['场景'], '天台');
});

test('merges and dedupes names across repeated present markers', () => {
    const markers = extractDiaryMarkers('[在场::小绝] 中途 [在场::可可, 小绝]');
    assert.deepEqual(markers.present, ['小绝', '可可']);
});

test('degrades to no markers instead of throwing on malformed text', () => {
    // 标记是可选富化信息，一个写歪的括号不该让整篇日记的投影进 dead_letter。
    for (const input of ['[场景::厨房', '在场::小绝]', '[[::]]', '', null, undefined, 12345]) {
        const markers = extractDiaryMarkers(input);
        assert.equal(markers.scene, null);
        assert.deepEqual(markers.present, []);
    }
});

test('ignores unknown keys but keeps them in raw', () => {
    // 未登记的键不参与投影，但保留在 raw 里，便于以后决定要不要提升为一等字段。
    const markers = extractDiaryMarkers('[天气::雨] [在场::可可]');
    assert.equal(markers.raw['天气'], '雨');
    assert.deepEqual(markers.present, ['可可']);
    assert.equal(markers.scene, null);
});

test('detects markers repeatedly despite the global regex flag', () => {
    const text = '[在场::小绝]';
    assert.equal(hasDiaryMarkers(text), true);
    assert.equal(hasDiaryMarkers(text), true);
    assert.equal(hasDiaryMarkers('今天没写标记。'), false);
});
