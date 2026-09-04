// 一次性取证脚本：测量 《《》》/<<>> 门控所用的「日记本名向量 vs 内容向量」余弦分布
// 目的：判定 GLOBAL_SIMILARITY_THRESHOLD = 0.6 在本部署下是否可达
// 用法: node scripts/probe_rag_gate_reachability.js   （只读，可与线上服务共存）
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'VectorStore/knowledge_base.sqlite'), { readonly: true });

const DIM = 3072;
const f32 = (buf) => new Float32Array(buf.buffer, buf.byteOffset, DIM);
const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

const names = db.prepare("SELECT key, vector FROM kv_store WHERE key LIKE 'diary_name:%'").all()
    .map(r => ({ name: r.key.slice('diary_name:'.length), v: f32(r.vector) }));

const chunks = db.prepare(`
    SELECT c.vector AS vector, f.diary_name AS diary
    FROM chunks c JOIN files f ON c.file_id = f.id
    WHERE c.vector IS NOT NULL
`).all().map(r => ({ diary: r.diary, v: f32(r.vector) }));

console.log(`名向量 ${names.length} 条 · 内容 chunk ${chunks.length} 条 · dim=${DIM}`);
console.log(`门控阈值 GLOBAL_SIMILARITY_THRESHOLD = 0.6\n`);

let globalMax = -1, globalArg = '';
const rows = [];
for (const n of names) {
    let mx = -1, mn = 2, sum = 0, over = 0, arg = '';
    for (const c of chunks) {
        const s = cos(n.v, c.v);
        sum += s;
        if (s > mx) { mx = s; arg = c.diary; }
        if (s < mn) mn = s;
        if (s >= 0.6) over++;
    }
    rows.push({ name: n.name, max: mx, avg: sum / chunks.length, min: mn, over, arg });
    if (mx > globalMax) { globalMax = mx; globalArg = `${n.name} × ${arg}`; }
}
rows.sort((a, b) => b.max - a.max);
console.log('日记本名'.padEnd(22) + 'max      avg      min      >=0.6');
for (const r of rows) {
    console.log(
        r.name.padEnd(20) +
        r.max.toFixed(4).padStart(8) +
        r.avg.toFixed(4).padStart(9) +
        r.min.toFixed(4).padStart(9) +
        String(r.over).padStart(8)
    );
}
const pairs = names.length * chunks.length;
const overAll = rows.reduce((a, r) => a + r.over, 0);
console.log(`\n全局最大 (名 × 任意内容): ${globalMax.toFixed(4)}  [${globalArg}]`);
console.log(`达到 0.6 的配对: ${overAll}/${pairs} (${(overAll / pairs * 100).toFixed(2)}%)`);
console.log(`结论: 0.6 门控${overAll === 0 ? '在全部配对中【从未】达到' : `实际可达率仅 ${(overAll / pairs * 100).toFixed(2)}%，等于默认关闭`}`);

// 参照：名向量之间的余弦，说明该 embedding 空间的基线水位
console.log('\n--- 参照：名向量互相之间的余弦 (同一空间基线) ---');
let pmax = -1, pmin = 2, psum = 0, pn = 0;
for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
        const s = cos(names[i].v, names[j].v);
        psum += s; pn++;
        if (s > pmax) pmax = s;
        if (s < pmin) pmin = s;
    }
}
console.log(`名-名 余弦: max=${pmax.toFixed(4)} avg=${(psum / pn).toFixed(4)} min=${pmin.toFixed(4)}`);
db.close();
