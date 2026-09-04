// 只读探针：确认某个日记本在向量库里是热的，且 RiverMemo 产物可用。
// 与线上服务共存安全：readonly 连接，不写不建表。
// 用法: node scripts/probe_diary_index_warm.js [日记本名]   （默认 纸子的知识）
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'VectorStore/knowledge_base.sqlite'), { readonly: true });

const DIARY = process.argv[2] || '纸子的知识';

const fileRow = db.prepare('SELECT COUNT(*) AS n FROM files WHERE diary_name = ?').get(DIARY);
const chunkRow = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS vectorized
    FROM chunks c JOIN files f ON c.file_id = f.id
    WHERE f.diary_name = ?
`).get(DIARY);

console.log(`日记本「${DIARY}」`);
console.log(`  files      : ${fileRow.n}`);
console.log(`  chunks     : ${chunkRow.total}（已向量化 ${chunkRow.vectorized}）`);

const allDiaries = db.prepare('SELECT diary_name, COUNT(*) AS n FROM files GROUP BY diary_name ORDER BY n DESC').all();
console.log(`\n库内全部日记本（${allDiaries.length} 个）:`);
for (const r of allDiaries) console.log(`  ${String(r.diary_name).padEnd(16)} ${r.n}`);

const arts = db.prepare(`
    SELECT artifact_sig, status, node_count, edge_count, published_at, updated_at
    FROM rivermemo_artifacts ORDER BY updated_at DESC LIMIT 5
`).all();
console.log(`\nRiverMemo 产物（最近 5 条 / 共 ${db.prepare('SELECT COUNT(*) AS n FROM rivermemo_artifacts').get().n} 条）:`);
for (const a of arts) {
    console.log(`  ${a.artifact_sig.slice(0, 12)}… status=${a.status} nodes=${a.node_count} edges=${a.edge_count} published=${a.published_at || '-'}`);
}
const ready = arts.filter((a) => a.status === 'ready' || a.status === 'published');
console.log(`\n结论: ${chunkRow.vectorized > 0 ? '✔' : '✘'} 该日记本可被向量检索；${ready.length > 0 ? '✔' : '✘'} 存在可用 RiverMemo 产物`);
db.close();
