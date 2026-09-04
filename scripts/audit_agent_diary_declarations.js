// 审计所有 Agent/*.txt 的日记声明：语法可达性 + 磁盘/索引存在性。
// 只读，可反复运行。用法: node tmp/audit_agent_diary_declarations.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');

const grab = (key) => {
    const m = SRC.match(new RegExp(
        `const\\s+${key}Declarations\\s*=\\s*\\[\\.\\.\\.processedContent\\.matchAll\\((/.*?/)g\\)\\]`
    ));
    if (!m) throw new Error(`解析处已变更：找不到 ${key}Declarations`);
    return new RegExp(m[1].slice(1, -1), 'g');
};
const RE = { rag: grab('rag'), fullText: grab('fullText'), hybrid: grab('hybrid'), direct: grab('directDiaries') };

const db = new Database(path.join(ROOT, 'VectorStore/knowledge_base.sqlite'), { readonly: true });
const indexed = new Map(
    db.prepare(`SELECT f.diary_name AS d, COUNT(*) AS n,
                       SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS v
                FROM chunks c JOIN files f ON c.file_id = f.id GROUP BY f.diary_name`)
        .all().map((r) => [r.d, r])
);
db.close();

const SYNTAX = {
    rag: { label: '[[ ]]', gated: false },
    fullText: { label: '<< >>', gated: true },
    hybrid: { label: '《《 》》', gated: true },
    direct: { label: '{{ }}', gated: false },
};

const rows = [];
for (const file of fs.readdirSync(path.join(ROOT, 'Agent')).filter((f) => f.endsWith('.txt'))) {
    const content = fs.readFileSync(path.join(ROOT, 'Agent', file), 'utf8').replace(/\[\[AIMemo=True\]\]/g, '');
    for (const [kind, re] of Object.entries(RE)) {
        for (const m of content.matchAll(re)) {
            // 多日记本用 | 分隔：[[A|B日记本::mods]]
            for (const name of m[1].split('|').map((s) => s.trim()).filter(Boolean)) {
                const dir = path.join(ROOT, 'dailynote', name);
                const onDisk = fs.existsSync(dir)
                    ? fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).length
                    : null;
                const idx = indexed.get(name);
                rows.push({
                    file, name, syntax: SYNTAX[kind].label, gated: SYNTAX[kind].gated,
                    mods: (m[2] || '').trim(), onDisk, vectorized: idx ? idx.v : 0,
                });
            }
        }
    }
}

const verdict = (r) => {
    if (r.onDisk === null) return '✘ 日记目录不存在';
    if (r.onDisk === 0) return '✘ 目录为空';
    if (r.vectorized === 0) return '✘ 未向量化';
    if (r.gated) return '✘ 门控语法（本部署阈值不可达）';
    return '✔ 可召回';
};

rows.sort((a, b) => (verdict(a) === verdict(b) ? a.file.localeCompare(b.file) : verdict(a).localeCompare(verdict(b))));

const W = [22, 20, 10, 7, 7, 30];
const pad = (s, n) => {
    const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return String(s) + ' '.repeat(Math.max(1, n - w));
};
console.log(pad('Agent 文件', W[0]) + pad('日记本', W[1]) + pad('语法', W[2]) + pad('磁盘', W[3]) + pad('向量', W[4]) + '判定');
console.log('-'.repeat(100));
for (const r of rows) {
    console.log(
        pad(r.file, W[0]) + pad(r.name, W[1]) + pad(r.syntax, W[2]) +
        pad(r.onDisk === null ? '-' : r.onDisk, W[3]) + pad(r.vectorized, W[4]) + verdict(r)
    );
}
const bad = rows.filter((r) => !verdict(r).startsWith('✔'));
console.log(`\n共 ${rows.length} 条声明，其中 ${bad.length} 条无法召回。`);

// 按失败模式分账（B 与 C 会重叠，上面的 verdict 是短路的单一判定，这里给交叉数）
const isC = (r) => r.onDisk === null || r.onDisk === 0 || r.vectorized === 0;
const gated = rows.filter((r) => r.gated);
const cOnly = rows.filter((r) => isC(r) && !r.gated);
console.log(`  B 门控语法        : ${gated.length} 条（其中目录已就绪、仅被门控挡住: ${gated.filter((r) => !isC(r)).length} 条）`);
console.log(`  C 目录缺失/未索引 : ${rows.filter(isC).length} 条（其中语法本身没问题: ${cOnly.length} 条）`);
console.log(`  B ∩ C 同时中两条  : ${gated.filter(isC).length} 条`);
console.log(`\nfiles 表已索引文件总数: ${
    (() => {
        const d2 = new Database(path.join(ROOT, 'VectorStore/knowledge_base.sqlite'), { readonly: true });
        const n = d2.prepare('SELECT COUNT(*) AS n FROM files').get().n;
        d2.close();
        return n;
    })()
}`);
