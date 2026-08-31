// EmbeddingUtils.js
const fs = require('fs').promises;
const path = require('path');
const { get_encoding } = require("@dqbd/tiktoken");
const encoding = get_encoding("cl100k_base");

// 配置
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const MAX_BATCH_ITEMS = parseInt(process.env.EMBEDDING_MAX_BATCH_ITEMS, 10) || 32; // Embedding 单批最大条数，可通过 env 控制
const DEFAULT_CONCURRENCY = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY) || 5; // 🌟 读取并发配置
// 🕐 Embedding 单次请求超时（毫秒）。未配置时默认 60s；上游挂起时不再无限等待。
const EMBEDDING_TIMEOUT_MS = Math.max(5000, parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10) || 60000);
const EMBEDDING_AUDIT_LOG_ENABLED = String(process.env.EMBEDDING_AUDIT_LOG_ENABLED || 'false').toLowerCase() === 'true';
const EMBEDDING_AUDIT_LOG_DIR = path.join(__dirname, 'DebugLog');
const EMBEDDING_AUDIT_LOG_FILE = path.join(EMBEDDING_AUDIT_LOG_DIR, 'embeddinglog');

/**
 * 将成功向量化的原文写入独立审计日志。
 * 日志写入失败不会影响正常的向量化流程，也不会进入服务器日志系统。
 */
async function _writeEmbeddingAuditLog(texts) {
    if (!EMBEDDING_AUDIT_LOG_ENABLED || !texts || texts.length === 0) return;

    const records = texts.map(content => JSON.stringify({
        timestamp: new Date().toISOString(),
        content
    })).join('\n') + '\n';

    try {
        await fs.mkdir(EMBEDDING_AUDIT_LOG_DIR, { recursive: true });
        await fs.appendFile(EMBEDDING_AUDIT_LOG_FILE, records, 'utf8');
    } catch (_) {
        // 开发审计日志不得影响向量服务，也不转发到服务器日志。
    }
}

function _splitModelList(value) {
    return String(value || '')
        .split(/[,，]/)
        .map(model => model.trim())
        .filter(Boolean);
}

function _getEmbeddingModelCandidates(config = {}) {
    const candidates = [];

    const addModel = (model) => {
        const normalized = String(model || '').trim();
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    addModel(config.model || process.env.WhitelistEmbeddingModel);

    if (Array.isArray(config.modelBackups)) {
        config.modelBackups.forEach(addModel);
    } else if (config.modelBackups) {
        _splitModelList(config.modelBackups).forEach(addModel);
    }

    _splitModelList(process.env.EmbeddingModelBackups).forEach(addModel);

    for (let i = 1; i <= 9; i++) {
        addModel(process.env[`EmbeddingModelBackup${i}`]);
    }

    // 兼容用户误把多个备援写进单个变量的情况。
    _splitModelList(process.env.EmbeddingModelBackup).forEach(addModel);

    return candidates.length > 0 ? candidates : ['google/gemini-embedding-001'];
}

function _isTransientEmbeddingError(status, message = '') {
    const text = String(message || '');
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    // new-api 单通道抖动时常返回 503 + no available channel / model_not_found
    return /no available channel|model_not_found|upstream|timeout|econnreset|socket hang up|temporar/i.test(text);
}

/**
 * 内部函数：发送单个批次
 * 策略：只按配置的模型候选列表走；每个模型对 429/503 等瞬时错误做同模型重试，
 * 避免“只开一个 embedding 组别”时偶发抖动直接整批失败。
 */
async function _sendBatch(batchTexts, config, batchNumber) {
    const { default: fetch } = await import('node-fetch');
    const modelCandidates = _getEmbeddingModelCandidates(config);
    const perModelRetries = Math.max(1, parseInt(process.env.EMBEDDING_TRANSIENT_RETRIES, 10) || 3);
    const baseDelay = Math.max(200, parseInt(process.env.EMBEDDING_RETRY_BASE_DELAY_MS, 10) || 1000);
    let lastError = null;

    for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex++) {
        const model = modelCandidates[modelIndex];

        for (let retry = 1; retry <= perModelRetries; retry++) {
            try {
                const requestUrl = `${config.apiUrl}/v1/embeddings`;
                const requestBody = { model, input: batchTexts };
                const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` };

                const response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody),
                    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS)
                });

                const responseBodyText = await response.text();

                if (!response.ok) {
                    const transient = _isTransientEmbeddingError(response.status, responseBodyText);
                    const err = new Error(`API Error ${response.status}: ${responseBodyText.substring(0, 500)}`);
                    if (transient && retry < perModelRetries) {
                        const waitTime = Math.min(baseDelay * Math.pow(2, retry - 1), 15000);
                        console.warn(`[Embedding] Batch ${batchNumber} model "${model}" transient ${response.status} (${retry}/${perModelRetries}). Retry same model in ${waitTime / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        lastError = err;
                        continue;
                    }
                    throw err;
                }

                let data;
                try {
                    data = JSON.parse(responseBodyText);
                } catch (parseError) {
                    console.error(`[Embedding] JSON Parse Error for Batch ${batchNumber}:`);
                    console.error(`Response (first 500 chars): ${responseBodyText.substring(0, 500)}`);
                    throw new Error(`Failed to parse API response as JSON: ${parseError.message}`);
                }

                // 增强的响应结构验证和详细错误信息
                if (!data) {
                    throw new Error(`API returned empty/null response`);
                }

                // 检查是否是错误响应
                if (data.error) {
                    const errorMsg = data.error.message || JSON.stringify(data.error);
                    const errorCode = data.error.code || response.status;
                    console.error(`[Embedding] API Error for Batch ${batchNumber}:`);
                    console.error(`  Error Code: ${errorCode}`);
                    console.error(`  Error Message: ${errorMsg}`);
                    console.error(`  Hint: Check if embedding model "${model}" is available on your API server`);
                    const err = new Error(`API Error ${errorCode}: ${errorMsg}`);
                    if (_isTransientEmbeddingError(errorCode, errorMsg) && retry < perModelRetries) {
                        const waitTime = Math.min(baseDelay * Math.pow(2, retry - 1), 15000);
                        console.warn(`[Embedding] Batch ${batchNumber} model "${model}" transient body error (${retry}/${perModelRetries}). Retry same model in ${waitTime / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        lastError = err;
                        continue;
                    }
                    throw err;
                }

                if (!data.data) {
                    console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                    console.error(`Response keys: ${Object.keys(data).join(', ')}`);
                    console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                    throw new Error(`Invalid API response structure: missing 'data' field`);
                }

                if (!Array.isArray(data.data)) {
                    console.error(`[Embedding] 'data' field is not an array for Batch ${batchNumber}`);
                    console.error(`data type: ${typeof data.data}`);
                    console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                    throw new Error(`Invalid API response structure: 'data' is not an array`);
                }

                if (data.data.length === 0) {
                    console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
                }

                // 简单的 Log，证明并发正在跑
                // console.log(`[Embedding] ✅ Batch ${batchNumber} completed (${batchTexts.length} items) via ${model}.`);

                const sortedData = data.data.sort((a, b) => a.index - b.index);
                const successfullyVectorizedTexts = sortedData
                    .filter(item => item && item.embedding && Number.isInteger(item.index) && item.index >= 0 && item.index < batchTexts.length)
                    .map(item => batchTexts[item.index]);

                await _writeEmbeddingAuditLog(successfullyVectorizedTexts);

                return sortedData.map(item => item.embedding);

            } catch (e) {
                lastError = e;
                const transient = _isTransientEmbeddingError(0, e.message);
                console.warn(`[Embedding] Batch ${batchNumber}, Model "${model}" failed (model ${modelIndex + 1}/${modelCandidates.length}, try ${retry}/${perModelRetries}): ${e.message}`);
                if (transient && retry < perModelRetries) {
                    const waitTime = Math.min(baseDelay * Math.pow(2, retry - 1), 15000);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                // 同模型重试用尽，换下一个候选；没有候选则抛出
                break;
            }
        }
    }

    throw lastError || new Error('Embedding request failed with no model candidates');
}

/**
 * 🚀 终极版：并发批量获取 Embeddings
 * 🛡️ 核心保证：返回数组长度 === 输入 texts 长度，跳过/失败的位置填 null
 */
async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];

    // 1. ⚡️ 第一步：纯 CPU 操作，先把所有文本切分成 Batches
    //    同时记录每个文本在原始数组中的索引，以便后续对齐
    const batches = [];         // 每个元素: { texts: string[], originalIndices: number[] }
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set(); // 记录被跳过的超长文本位置

    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) {
            console.warn(`[Embedding] ⚠️ Text at index ${i} exceeds token limit (${textTokens} > ${safeMaxTokens}), skipping.`);
            oversizeIndices.add(i);
            continue; // Skip oversize，但记录位置
        }

        const isTokenFull = currentBatchTexts.length > 0 && (currentBatchTokens + textTokens > safeMaxTokens);
        const isItemFull = currentBatchTexts.length >= MAX_BATCH_ITEMS;

        if (isTokenFull || isItemFull) {
            batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
            currentBatchTexts = [text];
            currentBatchIndices = [i];
            currentBatchTokens = textTokens;
        } else {
            currentBatchTexts.push(text);
            currentBatchIndices.push(i);
            currentBatchTokens += textTokens;
        }
    }
    if (currentBatchTexts.length > 0) {
        batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
    }

    if (oversizeIndices.size > 0) {
        console.warn(`[Embedding] ⚠️ ${oversizeIndices.size} texts skipped due to token limit.`);
    }
    console.log(`[Embedding] Prepared ${batches.length} batches from ${texts.length} texts. Executing with concurrency: ${DEFAULT_CONCURRENCY}...`);

    // 2. 🌊 第二步：并发执行器
    const batchResults = new Array(batches.length); // 预分配结果数组，保证顺序
    let cursor = 0; // 当前处理到的批次索引

    // 定义 Worker：只要队列里还有任务，就不断抢任务做
    const worker = async (workerId) => {
        while (true) {
            // 🔒 获取任务索引 (原子操作模拟)
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break; // 没任务了，下班

            const batch = batches[batchIndex];
            try {
                // 执行请求 (Batch ID 从 1 开始显示)
                batchResults[batchIndex] = {
                    vectors: await _sendBatch(batch.texts, config, batchIndex + 1),
                    originalIndices: batch.originalIndices
                };
            } catch (e) {
                // 🛡️ 不再让单个 batch 失败导致整个 Promise.all 崩溃
                // 而是记录失败，对应位置将填 null
                console.error(`[Embedding] ❌ Batch ${batchIndex + 1} failed permanently: ${e.message}`);
                batchResults[batchIndex] = {
                    vectors: null, // 标记为失败
                    originalIndices: batch.originalIndices,
                    error: e.message
                };
            }
        }
    };

    // 启动 N 个 Worker
    const workers = [];
    for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
        workers.push(worker(i));
    }

    // 等待所有 Worker 下班
    await Promise.all(workers);

    // 3. 📦 第三步：按原始索引回填结果，保证 output.length === input.length
    const finalResults = new Array(texts.length).fill(null); // 默认全部为 null
    let successCount = 0;
    let failCount = 0;

    for (const result of batchResults) {
        if (!result || !result.vectors) {
            // 整个 batch 失败，对应位置保持 null
            if (result) failCount += result.originalIndices.length;
            continue;
        }
        result.originalIndices.forEach((origIdx, vecIdx) => {
            finalResults[origIdx] = result.vectors[vecIdx] || null;
            if (result.vectors[vecIdx]) successCount++;
            else failCount++;
        });
    }

    failCount += oversizeIndices.size; // 超长文本也算失败

    if (failCount > 0) {
        console.warn(`[Embedding] ⚠️ Results: ${successCount} succeeded, ${failCount} failed/skipped out of ${texts.length} total.`);
    }

    return finalResults; // 🛡️ 长度严格等于 texts.length，失败位置为 null
}

/**
 * 余弦相似度计算（公共版本）
 * 供 toolExecutor / messageProcessor / 其他模块复用
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

module.exports = { getEmbeddingsBatch, cosineSimilarity };
