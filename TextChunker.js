// TextChunker.js
require('dotenv').config({ path: './config.env' });
const { get_encoding } = require("@dqbd/tiktoken"); // 假设您已安装 tiktoken 用于精确计算
const encoding = get_encoding("cl100k_base"); // gpt-4, gpt-3.5, embedding models 常用

// 从 config.env 文件读取最大 token 数，并应用85%的安全边界
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const defaultOverlapTokens = Math.floor(safeMaxTokens * 0.1); // 重叠部分为最大值的10%

console.log(`[TextChunker] 配置加载: MaxToken=${embeddingMaxToken}, SafeMaxTokens=${safeMaxTokens}, OverlapTokens=${defaultOverlapTokens}`);

/**
 * 智能文本切分器
 * @param {string} text - 需要切分的原始文本
 * @param {number} maxTokens - 每个切片的最大token数
 * @param {number} overlapTokens - 切片间的重叠token数，以保证上下文连续性
 * @returns {string[]} 切分后的文本块数组
 */
function chunkText(text, maxTokens = safeMaxTokens, overlapTokens = defaultOverlapTokens) {
    if (!text) return [];

    const sentences = text.split(/(?<=[。？！.!?\n])/g); // 按句子和换行符分割，保留分隔符
    const chunks = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (let i = 0; i < sentences.length; i++) {
        let sentence = sentences[i];
        let sentenceTokens = encoding.encode(sentence).length;

        // 处理超长句子：如果单个句子超过maxTokens，需要强制分割
        if (sentenceTokens > maxTokens) {
            // 先保存当前切片（如果有内容）
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
                currentTokens = 0;
            }
            
            // 对超长句子进行强制分割
            const forceSplitChunks = forceSplitLongText(sentence, maxTokens, overlapTokens);
            chunks.push(...forceSplitChunks);
            continue;
        }

        if (currentTokens + sentenceTokens > maxTokens) {
            chunks.push(currentChunk.trim());
            
            // 创建重叠部分
            let overlapChunk = "";
            let overlapTokenCount = 0;
            for (let j = i - 1; j >= 0; j--) {
                const prevSentence = sentences[j];
                const prevSentenceTokens = encoding.encode(prevSentence).length;
                if (overlapTokenCount + prevSentenceTokens > overlapTokens) break;
                overlapChunk = prevSentence + overlapChunk;
                overlapTokenCount += prevSentenceTokens;
            }
            currentChunk = overlapChunk;
            currentTokens = overlapTokenCount;
        }
        
        currentChunk += sentence;
        currentTokens += sentenceTokens;
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
}

/**
 * 强制分割超长文本
 * @param {string} text - 需要分割的超长文本
 * @param {number} maxTokens - 每个切片的最大token数
 * @param {number} overlapTokens - 切片间的重叠token数
 * @returns {string[]} 分割后的文本块数组
 */
function forceSplitLongText(text, maxTokens, overlapTokens) {
    const chunks = [];
    const tokens = encoding.encode(text);

    // Safety check to prevent infinite loop
    const safeOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));
    const decoder = new TextDecoder('utf-8');

    // token id -> 文本需要两步：encoding.decode() 先还原成 UTF-8 字节流，再交给 TextDecoder。
    // 少了前一步就是把 Uint32Array 按 4 字节/元素当文本解，产出乱码且 token 数膨胀约 4 倍。
    // 另外 token 边界可能切在多字节字符中间（一个汉字常占 2 个 token），解码后两端会残留
    // U+FFFD，必须剪掉，否则残缺字符会被写进向量库正文。这里用 fromCharCode 构造而不是写
    // 字面量，避免源码本身被编码转换弄坏后这段清理逻辑静默失效。
    const REPLACEMENT = String.fromCharCode(0xFFFD);
    const HEAD_PARTIAL = new RegExp('^' + REPLACEMENT + '+');
    const TAIL_PARTIAL = new RegExp(REPLACEMENT + '+$');

    const decodeRange = (from, to) => decoder
        .decode(encoding.decode(tokens.slice(from, to)))
        .replace(HEAD_PARTIAL, '')
        .replace(TAIL_PARTIAL, '');

    let start = 0;
    while (start < tokens.length) {
        let end = Math.min(start + maxTokens, tokens.length);

        // 尝试在合适的位置断开（避免在词汇中间断开）
        if (end < tokens.length) {
            const spanTokens = end - start;
            const chunkText = decodeRange(start, end);

            // 尝试在标点符号或空白处断开
            const breakPoints = ['\n', '。', '！', '？', '，', '；', '：', ' ', '\t'];
            let bestBreakPoint = -1;

            for (let i = chunkText.length - 1; i >= Math.max(0, chunkText.length - 200); i--) {
                if (breakPoints.includes(chunkText[i])) {
                    bestBreakPoint = i + 1;
                    break;
                }
            }

            let finalChunkText = chunkText;
            if (bestBreakPoint > 0) {
                const candidateText = chunkText.substring(0, bestBreakPoint);
                const newTokens = encoding.encode(candidateText);

                // Prevent infinite loop: only accept the breakpoint if it provides meaningful progress
                if (newTokens.length > safeOverlap || newTokens.length === spanTokens) {
                    finalChunkText = candidateText;
                }
            }

            // 按“实际写出的文本”重新对齐 end：剪掉残缺字符或截到断点都会改变 token 数，
            // 沿用原 span 会让下一片错位。上界钳在 spanTokens，避免重新编码变长时跳过正文。
            end = start + Math.max(1, Math.min(spanTokens, encoding.encode(finalChunkText).length));

            chunks.push(finalChunkText.trim());
        } else {
            // 最后一块：已经吃到 tokens 结尾，必须就地收尾。
            // 不能继续走下面的 overlap 回退——那会把 start 拉回 tokens.length - safeOverlap，
            // 于是尾部被反复切出约 safeOverlap 片几乎相同的冗余 chunk（每轮只推进 1 token）。
            chunks.push(decodeRange(start, tokens.length).trim());
            break;
        }

        // 计算下一个起始位置（考虑重叠），确保 start 至少向前推进 1 步，即使 end 没有发生变化
        start = Math.max(start + 1, end - safeOverlap);
    }

    return chunks.filter(chunk => chunk.length > 0);
}

module.exports = { chunkText };