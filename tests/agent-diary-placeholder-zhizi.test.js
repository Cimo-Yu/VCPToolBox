// 回归测试：Agent/Zhizi.txt 必须声明「纸子的知识」日记本，且走无门控的 [[ ]] 分支。
//
// 真因背景（2026-08-10 生产事故：自动注入连续多轮全空）：
//   当天 8 轮预处理日志全部是 `Total processing promises: 1`，那 1 个是 [[VCP元思考::Group]]。
//   Zhizi.txt 的记忆区当时没有任何日记声明 —— 被动注入管线跑了，但无可解析对象。
//
// 为什么不能退回 《《...》》：
//   门控分支 (_getDiarySimilarityCached) 比较的是
//   max(cos(query, embedding("日记本名字符串")), cos(query, enhancedVector))。
//   enhancedVector 由 rag_tags.json 构建，本部署没有该文件 → 该项恒为 0，
//   门控退化成「查询 vs 4~7 字裸名」，实测水位 0.42~0.59 < GLOBAL_SIMILARITY_THRESHOLD(0.6)，
//   等于把开关焊死在 OFF；未达阈值时返回 content:'' 且写入缓存，整体不注入、不降级。
//   [[ ]] 分支无门控，直接进 _processRAGPlaceholder。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AGENT_FILE = path.join(ROOT, 'Agent', 'Zhizi.txt');
const PARSE_SITE = path.join(ROOT, 'Plugin', 'RAGDiaryPlugin', 'RAGDiaryPlugin.js');

const DIARY_NAME = '纸子的知识';

/**
 * 从 RAGDiaryPlugin.js 里抠出四种被动语法的正则本体，而不是在测试里抄一份。
 * 解析处一旦被改名或改写，这里会立刻失败，而不是让测试静默失去意义。
 */
function extractDeclarationRegexes() {
    const src = fs.readFileSync(PARSE_SITE, 'utf8');
    const keys = ['rag', 'fullText', 'hybrid', 'metaThinking', 'directDiaries'];
    const out = {};
    for (const key of keys) {
        const finder = new RegExp(
            `const\\s+${key}Declarations\\s*=\\s*\\[\\.\\.\\.processedContent\\.matchAll\\((/.*?/)g\\)\\]`
        );
        const m = src.match(finder);
        assert.ok(m, `解析处已变更：在 RAGDiaryPlugin.js 中找不到 ${key}Declarations 的 matchAll 声明`);
        out[key] = new RegExp(m[1].slice(1, -1), 'g');
    }
    return out;
}

/** 复刻 _processRAGPlaceholders 进入声明扫描前的唯一改写（移除 AIMemo 许可证占位符） */
function loadAgentContent() {
    return fs.readFileSync(AGENT_FILE, 'utf8').replace(/\[\[AIMemo=True\]\]/g, '');
}

function scan() {
    const RE = extractDeclarationRegexes();
    const content = loadAgentContent();
    const result = {};
    for (const [key, re] of Object.entries(RE)) {
        result[key] = [...content.matchAll(re)];
    }
    return result;
}

test('Zhizi.txt 恰好声明一个日记本，且是「纸子的知识」', () => {
    const { rag } = scan();
    assert.equal(rag.length, 1, `期望 1 条 [[...日记本...]] 声明，实际 ${rag.length} 条`);
    assert.equal(rag[0][1], DIARY_NAME);
});

test('声明走无门控 [[ ]] 分支：不存在 《《》》 或 <<>> 门控语法', () => {
    const { hybrid, fullText } = scan();
    assert.equal(hybrid.length, 0, '《《...日记本...》》 是双阈值门控，在缺 rag_tags.json 的本部署下永不触发');
    assert.equal(fullText.length, 0, '<<...日记本...>> 是单阈值门控，同样不可达');
});

test('修饰器使用 ::RiverMemo::Time，且不带空转的 ::Rerank+', () => {
    const { rag } = scan();
    const modifiers = rag[0][2];
    assert.match(modifiers, /::RiverMemo(?=$|::|:\d)/i, 'RiverMemo 拓扑引擎修饰器丢失');
    // ::Rerank / ::Rerank+ 要打外部 rerank 服务（url+apiKey+model），本部署 config.env 无 Rerank* 键，
    // _rerankDocuments 会打 WARN 后降级成 documents.slice(0, K)，并且白白放大候选池
    // （finalK * multiplier + dedupBuffer）。排序由 RiverMemo 测地线负责，不需要它。
    // 2026-08-11 已全库移除（8 个维度 agent 一并清理），此处断言防回潮。
    assert.doesNotMatch(modifiers, /::Rerank/i, '::Rerank 在本部署是空转，只会放大候选池并打 WARN');
    // ::Time 时效补充召回（默认 80/20 时间路比例，可用 ::Time0.1-::Time0.9 显式调）：
    // 2026-08-11 决策 —— RiverMemo 的 Ω 排序无时效信号，新写入的日记在图谱外围，
    // 稠密态下会被选择阶段裁掉；::Time 补一条时间路让近期内容有机会进上下文。
    assert.match(modifiers, /::Time(?:\d*\.?\d+)?(?=$|::)/i, '::Time 时效补充召回修饰器丢失');
});

test('元思考链仍在，且本轮 processingPromises 应为 2', () => {
    const { rag, fullText, hybrid, metaThinking, directDiaries } = scan();
    assert.equal(metaThinking.length, 1, '[[VCP元思考::Group]] 丢失');
    assert.equal(directDiaries.length, 0, '{{...日记本...}} 纯文本直取未使用（与生产日志 "Found 0 {{...}} declarations" 一致）');
    // 每条声明恰好推入一个 promise（真实 async 或短路的 Promise.resolve）
    const expected = metaThinking.length + rag.length + fullText.length + hybrid.length;
    assert.equal(expected, 2, '事故时为 1（仅元思考）；修复后应为 2（元思考 + 纸子的知识）');
});

test('声明的日记本在磁盘上存在且非空', () => {
    const dir = path.join(ROOT, 'dailynote', DIARY_NAME);
    assert.ok(fs.existsSync(dir), `日记目录不存在：${dir}`);
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));
    assert.ok(files.length > 0, `日记目录为空：${dir}`);
});

test('日记本名不会被冷知识库正则劫持', () => {
    // /\[\[(.*?)知识库(.*?)\]\]/ 会命中含「知识库」的名字，须靠 isDiaryPlaceholderAmbiguity 兜底；
    // 「纸子的知识」本身不含「知识库」，从源头避开歧义。
    assert.ok(!`${DIARY_NAME}日记本`.includes('知识库'), '日记本名含「知识库」，会与 TDB 冷知识库语法产生歧义');
});

test('agent_map.json 把「纸子」映射到 Zhizi.txt', () => {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent_map.json'), 'utf8'));
    assert.equal(map['纸子'], 'Zhizi.txt');
});

/**
 * 结构不变量：[[ ]] 分支必须保持「无相似度门控」。
 * 这是本次修复赖以成立的前提 —— 一旦有人给它加上 finalSimilarity 比较，
 * 事故会以完全相同的形态复发（占位符在、检索却静默返回空）。
 */
test('[[ ]] 分支无相似度门控，而 <<>> / 《《》》 分支有', () => {
    const src = fs.readFileSync(PARSE_SITE, 'utf8');
    const lines = src.split('\n');
    const lineOf = (needle) => {
        const i = lines.findIndex((l) => l.includes(needle));
        assert.ok(i >= 0, `解析处已变更：找不到 "${needle}"`);
        return i;
    };

    const ragStart = lineOf('for (const match of ragDeclarations)');
    const fullTextStart = lineOf('for (const match of fullTextDeclarations)');
    const hybridStart = lineOf('for (const match of hybridDeclarations)');
    const aiMemoStart = lineOf('--- 4. 聚合处理所有 AIMemo');

    const region = (from, to) => lines.slice(from, to).join('\n');
    const GATE = /finalSimilarity\s*>=/;

    assert.ok(ragStart < fullTextStart && fullTextStart < hybridStart && hybridStart < aiMemoStart,
        '分支顺序已变更，区间切分失效');

    assert.doesNotMatch(region(ragStart, fullTextStart), GATE,
        '[[ ]] 分支被加入了相似度门控 —— 本部署缺 rag_tags.json，门控只比裸名向量，会让检索永久静默返回空');
    assert.match(region(ragStart, fullTextStart), /_processRAGPlaceholder\(/,
        '[[ ]] 分支不再直接调用 _processRAGPlaceholder');

    // 对照组：确认 GATE 正则确实认得出门控，避免上面的 doesNotMatch 是因为正则写错而空过
    assert.match(region(fullTextStart, hybridStart), GATE, '对照失效：<<>> 分支本应有门控');
    assert.match(region(hybridStart, aiMemoStart), GATE, '对照失效：《《》》 分支本应有门控');
});
