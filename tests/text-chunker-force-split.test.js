'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { chunkText } = require('../TextChunker');

// config.env 的 WhitelistEmbeddingModelMaxToken=8000，TextChunker 打 85% 得 6800。
const MAX_TOKENS = 6800;
const OVERLAP_TOKENS = 680;

const { get_encoding } = require('@dqbd/tiktoken');
const encoding = get_encoding('cl100k_base');
const tok = (s) => encoding.encode(s).length;

// U+FFFD 与 C0 控制符：token id 被误当字节流解码后的乱码签名。
const MOJIBAKE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\ufffd]');

// 触发 force-split 的最小条件：单个“句子”（内部无换行、无 。？！.!?）超过 maxTokens。
// 切一次 4 万 token 要几秒，三个断言共用同一份结果。
const HOMOGENEOUS_INPUT = '啊'.repeat(20000) + '。';
const HOMOGENEOUS_CHUNKS = chunkText(HOMOGENEOUS_INPUT);

test('force-split path returns real text, not token-id mojibake', () => {
    // 旧实现把 Uint32Array 的 token id 直接交给 TextDecoder，产出乱码且 token 数膨胀约 4 倍。
    assert.ok(HOMOGENEOUS_CHUNKS.length > 1, '超长单句必须被强制切开');
    assert.ok(!HOMOGENEOUS_CHUNKS.some((c) => MOJIBAKE.test(c)), '切片内不得出现控制符 / U+FFFD');
    // 原文只有「啊」和句号，出现任何别的字符就说明解码错了。
    assert.ok(HOMOGENEOUS_CHUNKS.every((c) => /^[啊。]+$/.test(c)), '切片必须是原字符本身');
});

test('force-split keeps every chunk inside the embedding window', () => {
    const sizes = HOMOGENEOUS_CHUNKS.map(tok);
    assert.ok(Math.max(...sizes) <= MAX_TOKENS, `最大切片 ${Math.max(...sizes)} 超过 ${MAX_TOKENS}`);
});

test('force-split terminates instead of grinding out one token per pass', () => {
    // 旧实现吃到结尾后不收尾，start 被 overlap 拉回 tokens.length - safeOverlap，
    // 于是尾部重复切出约 680 片近乎相同的冗余 chunk（实测 40001 token 产出 687 片）。
    const ceiling = Math.ceil(tok(HOMOGENEOUS_INPUT) / (MAX_TOKENS - OVERLAP_TOKENS)) + 2;
    assert.ok(HOMOGENEOUS_CHUNKS.length <= ceiling, `切片数 ${HOMOGENEOUS_CHUNKS.length} 远超合理上限 ${ceiling}`);
    // 只应存在 overlap 造成的少量重复，不该出现数倍膨胀。
    const inflation = HOMOGENEOUS_CHUNKS.join('').length / HOMOGENEOUS_INPUT.length;
    assert.ok(inflation < 1.5, `正文膨胀 ${inflation.toFixed(2)}× ，overlap 之外还有重复`);
});

test('force-split still covers the whole input when a breakpoint exists', () => {
    // 命中标点断点的分支：断点会改变 token 数，end 必须按实际写出的文本重新对齐，
    // 否则下一片起点错位，中间的正文会被整段跳过。
    let body = '';
    while (tok(body) < 30000) body += '甲乙丙丁, abc def 戊己庚辛，';
    const chunks = chunkText(body + '。');

    assert.ok(!chunks.some((c) => MOJIBAKE.test(c)));
    assert.ok(Math.max(...chunks.map(tok)) <= MAX_TOKENS);
    const stripSpace = (s) => s.replace(/\s/g, '');
    assert.ok(
        stripSpace(chunks.join('')).length >= stripSpace(body).length,
        '拼回来的正文短于原文，说明有内容被跳过'
    );
});

test('normal sentence path is unaffected', () => {
    // 回归护栏：绝大多数日记走的是这条路，切片边界不能因为修 force-split 而漂移。
    const sizes = chunkText('这是一个用于测试切分器边界行为的中文句子。'.repeat(1200)).map(tok);
    assert.deepEqual(sizes, [6798, 6798, 6798, 6798, 1848]);
});

test('short text stays a single chunk', () => {
    assert.deepEqual(chunkText('第一句。第二句。'), ['第一句。第二句。']);
    assert.deepEqual(chunkText(''), []);
});
