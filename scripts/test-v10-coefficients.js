// V10 / RiverMemo Topology V3 三系数独立测试脚本
//
// 直连 rust-vexus-lite 原生内核，绕过 HTTP 服务，用固定的查询观测和候选集，
// 对 topologyV3 三个系数做参数扫描：
//   omegaGamma           Ω^γ 河网可观测性门控指数
//   structRoleMinOmega   角色结构 Ω 下限
//   anchorBonusCap       直接锚点奖励上限
//
// 用法:
//   node scripts/test-v10-coefficients.js [queryText]
//   FORCE_ANCHOR=1 node scripts/test-v10-coefficients.js   # 放低锚点激活阈值，测 anchorBonusCap

'use strict';

const path = require('path');
const native = require('../rust-vexus-lite');
const Database = require('../node_modules/better-sqlite3');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'VectorStore', 'knowledge_base.sqlite');
const DIM = 3072;
const CANDIDATE_LIMIT = 20;
const EMBED_URL = 'http://localhost:3000/v1/embeddings';
const EMBED_KEY = 'sk-KxyryY3AAgGxOCE4UAsirITem7wqZx02tbtJjMkDCeX9jxFi';
const EMBED_MODEL = 'gemini-embedding-2-preview';

// ---------- 只读准备：最新 artifact + 真实 chunk 候选 ----------
function loadArtifactSig() {
    const db = new Database(DB_PATH, { readonly: true });
    try {
        const row = db.prepare(`
            SELECT artifact_sig FROM rivermemo_artifacts
            WHERE status = 'ready'
            ORDER BY published_at DESC LIMIT 1
        `).get();
        if (!row) throw new Error('没有可用的 ready artifact');
        return row.artifact_sig;
    } finally {
        db.close();
    }
}

function loadCandidateIds() {
    const db = new Database(DB_PATH, { readonly: true });
    try {
        const rows = db.prepare(`
            SELECT c.id
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE f.path LIKE '%纸子的知识%'
            ORDER BY f.updated_at DESC
            LIMIT ${CANDIDATE_LIMIT}
        `).all();
        return rows.map(r => r.id);
    } finally {
        db.close();
    }
}

async function embedQueryText(text) {
    const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${EMBED_KEY}`
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: [text] })
    });
    if (!response.ok) {
        throw new Error(`嵌入请求失败 ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== DIM) {
        throw new Error(`嵌入维度异常: 期望 ${DIM}, 实际 ${Array.isArray(embedding) ? embedding.length : 'N/A'}`);
    }
    return new Float32Array(embedding);
}

// ---------- 主流程 ----------
async function main() {
    const queryText = process.argv[2] || '韦伯 支配 正当性 三根基';
    const artifactSig = loadArtifactSig();
    const candidateIds = loadCandidateIds();
    console.log(`[V10 系数测试] artifact=${artifactSig}`);
    console.log(`[V10 系数测试] candidates=${candidateIds.length} ids=[${candidateIds.slice(0, 5).join(',')}...]`);

    const idx = new native.VexusIndex(DIM, 50000);
    await idx.recoverFromSqlite(DB_PATH, 'tags', null);

    console.log(`[V10 系数测试] 正在用真实嵌入模型向量化查询文本...`);
    const qv = await embedQueryText(queryText);
    console.log(`[V10 系数测试] 查询向量已就绪 (dim=${qv.length})`);
    const pipelineInput = JSON.stringify({
        queryId: 'v10-coefficient-sweep',
        queryText,
        queryVector: Array.from(qv),
        coreTags: [],
        ghostTags: [],
        config: {}
    });
    const pipelineOut = JSON.parse(await idx.runMemoPipeline(DB_PATH, artifactSig, pipelineInput));
    const handle = pipelineOut.observationHandle;
    console.log(`[V10 系数测试] 查询观测已准备 handle=${handle}`);

    const candidates = candidateIds.map(id => ({ id, score: 0 }));
    const baseInput = {
        observationHandle: handle,
        dimension: DIM,
        topK: 8,
        includeTrace: true,
        query: { text: queryText, vector: [] },
        denoisedVector: [],
        localVector: [],
        transferVector: [],
        candidates,
        queryState: {},
        allowedFileIds: []
    };

    const baseline = { omegaGamma: 1.0, structRoleMinOmega: 0.12, anchorBonusCap: 0.1 };
    const sweep = {
        omegaGamma: [0.5, 1.0, 2.0],
        structRoleMinOmega: [0.05, 0.12, 0.25, 0.9],
        anchorBonusCap: [0.05, 0.1, 0.2]
    };

    async function runOnce(config, label) {
        if (process.env.FORCE_ANCHOR === '1') {
            config = {
                ...config,
                anchorActivationFloor: 0.001,
                anchorActivationZ: 1
            };
        }
        const inputJson = JSON.stringify({ ...baseInput, config });
        const raw = await idx.rerankRivermemoTopologyV3(DB_PATH, artifactSig, inputJson);
        const out = JSON.parse(raw);
        const top = (out.results || []).slice(0, 5).map(r => ({
            id: r.id,
            score: Number(r.score).toFixed(4),
            role: r.role || '-',
            topo: Number(r.topologyBonus || 0).toFixed(4),
            anchor: Number(r.anchorBonus || 0).toFixed(4),
            trace: r.topologyV3 ? {
                omega: Number(r.topologyV3.omega || 0).toFixed(4),
                gate: Number(r.topologyV3.graphGate || 0).toFixed(4),
                v2: Number(r.topologyV3.gatedV2Bonus || 0).toFixed(4),
                anchorScore: Number(r.topologyV3.anchorScore || 0).toFixed(4)
            } : null
        }));
        const graphGate = Number(out.omega?.graphGate ?? out.diagnostics?.graphGate ?? 0).toFixed(4);
        console.log(`\n--- ${label} ---`);
        console.log(`Ω=${Number(out.omega?.omega || 0).toFixed(4)} regime=${out.omega?.regime || '-'} graphGate=${graphGate}`);
        top.forEach(t => {
            const tr = t.trace
                ? ` [Ω=${t.trace.omega} gate=${t.trace.gate} v2=${t.trace.v2} anchorScore=${t.trace.anchorScore}]`
                : '';
            console.log(`  #${t.id} score=${t.score} role=${t.role} topo=${t.topo} anchor=${t.anchor}${tr}`);
        });
        return out;
    }

    await runOnce(baseline, `基线 (γ=${baseline.omegaGamma}, minΩ=${baseline.structRoleMinOmega}, cap=${baseline.anchorBonusCap}${process.env.FORCE_ANCHOR === '1' ? ', FORCE_ANCHOR' : ''})`);

    for (const gamma of sweep.omegaGamma) {
        if (gamma === baseline.omegaGamma) continue;
        await runOnce({ ...baseline, omegaGamma: gamma }, `γ=${gamma} (其余基线)`);
    }
    for (const minOmega of sweep.structRoleMinOmega) {
        if (minOmega === baseline.structRoleMinOmega) continue;
        await runOnce({ ...baseline, structRoleMinOmega: minOmega }, `minΩ=${minOmega} (其余基线)`);
    }
    for (const cap of sweep.anchorBonusCap) {
        if (cap === baseline.anchorBonusCap) continue;
        await runOnce({ ...baseline, anchorBonusCap: cap }, `anchorCap=${cap} (其余基线)`);
    }

    console.log('\n[V10 系数测试] 完成。对比各组的 Ω / graphGate / 排名 / topologyBonus / anchorBonus 即可看出每个系数的影响。');
}

main().catch(err => {
    console.error('[V10 系数测试] 失败:', err.message || err);
    process.exit(1);
});
