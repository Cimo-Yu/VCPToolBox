'use strict';

/**
 * 覆盖两处「上游异常被放大成功能崩溃」的回归修复：
 *  1) EmbeddingUtils 单模型零重试 → 瞬态 503 应退避重试；最终失败应返回 null 而非抛出。
 *  2) LightMemo / RAGDiaryPlugin 的 RerankUrl 非空但不可解析（如模板残留 "your url"）
 *     → new URL 抛出的 TypeError 应被降级为「跳过 Rerank」，不得冒泡中断检索。
 *
 * 运行：node tests/embeddingRerankFallback.test.js
 */

process.env.EMBEDDING_RETRY_BASE_DELAY = '50';
process.env.EMBEDDING_RETRY_MAX_DELAY = '200';
process.env.EMBEDDING_MAX_RETRIES = '3';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');

const { getEmbeddingsBatch } = require(path.join(__dirname, '..', 'EmbeddingUtils.js'));

function makeEmbeddingResponse(dim) {
    return JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: new Array(dim).fill(0.01) }]
    });
}

/**
 * 起一个临时的 embedding 端点，按 plan 顺序决定每次请求的响应：
 * plan[i] = 'ok' 初次即成功 / '503' 返回 503 / 'ok1' 第一次 503 之后成功。
 */
async function withFakeEmbedServer(plan, fn) {
    let call = 0;
    const server = http.createServer((req, res) => {
        const step = plan[Math.min(call, plan.length - 1)];
        call++;
        if (step === '503') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'no available channel' } }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(makeEmbeddingResponse(8));
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        return await fn(apiUrl, () => call);
    } finally {
        await new Promise(r => server.close(r));
    }
}

test('EmbeddingUtils：初次 503 后经重试成功，向量不为 null', async () => {
    await withFakeEmbedServer(['503', '503', 'ok'], async (apiUrl, getCalls) => {
        const results = await getEmbeddingsBatch(['ping'], { apiUrl, apiKey: 'k' });
        assert.equal(results.length, 1);
        assert.ok(Array.isArray(results[0]), '重试后应拿到有效向量');
        assert.ok(getCalls() > 1, '应发起超过一次请求（证明发生了重试）');
    });
});

test('EmbeddingUtils：持续 503 时返回 null 占位，不抛异常且长度对齐', async () => {
    await withFakeEmbedServer(['503'], async (apiUrl) => {
        const results = await getEmbeddingsBatch(['a', 'b'], { apiUrl, apiKey: 'k' });
        assert.equal(results.length, 2, '返回长度必须严格等于输入长度');
        assert.ok(results.every(r => r === null), '全部失败时应为 null 占位');
    });
});

test('LightMemo._rerankDocuments：非法 RerankUrl 应跳过而非抛 Invalid URL', async () => {
    const LM = require(path.join(__dirname, '..', 'Plugin', 'LightMemo', 'LightMemo.js'));
    const saved = LM.rerankConfig;
    LM.rerankConfig = { url: 'your url', apiKey: 'your api', model: 'x', maxTokens: 30000 };
    try {
        const docs = [{ text: 'doc-a' }, { text: 'doc-b' }];
        const out = await LM._rerankDocuments('q', docs, 2);
        assert.equal(out.length, 2, '非法 URL 时应原样返回候选，不得中断');
    } finally {
        LM.rerankConfig = saved;
    }
});

test('RAGDiaryPlugin._rerankDocuments：非法 RerankUrl 应跳过而非抛 Invalid URL', async () => {
    const RAG = require(path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'RAGDiaryPlugin.js'));
    const saved = RAG.rerankConfig;
    RAG.rerankConfig = { url: 'your url', apiKey: 'your api', model: 'x', maxTokens: 30000, multiplier: 2, useJev: false };
    try {
        const docs = [{ text: 'doc-a' }, { text: 'doc-b' }];
        const out = await RAG._rerankDocuments('q', docs, 2);
        assert.equal(out.length, 2, '非法 URL 时应原样返回候选，不得中断');
    } finally {
        RAG.rerankConfig = saved;
    }
});