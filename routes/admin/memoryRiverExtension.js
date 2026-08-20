'use strict';

const express = require('express');
const path = require('node:path');
const { MemoryRiverRegistryV2 } = require('../../extensions/memory-river/MemoryRiverRegistryV2');
const { MemoryRiverExtension } = require('../../extensions/memory-river');
const { rebuildMemoryRiver } = require('../../extensions/memory-river/scripts/rebuild-memory-river');

function sendError(res, error) {
    return res.status(Number(error?.statusCode) || 500).json({ error: error?.message || 'Internal error', code: error?.code || 'MEMORY_RIVER_INTERNAL_ERROR' });
}

module.exports = function memoryRiverExtensionRoutes(options = {}) {
    const router = express.Router();
    const root = options.projectRoot || process.cwd();
    const registryPath = process.env.MEMORY_RIVER_REGISTRY_V2_PATH || path.join(root, 'extensions', 'memory-river', 'config', 'memory-rivers.v2.json');
    const databasePath = process.env.MEMORY_RIVER_DATABASE_PATH || path.join(root, 'extensions', 'memory-river', 'data', 'memory-river.sqlite');
    const registry = new MemoryRiverRegistryV2({ configPath: registryPath, createDefaultConfig: true });

    /**
     * 优先复用 KBM 生命周期宿主持有的那个扩展实例。
     * 该实例在事件到达时会内联 drain，与按请求新开的连接是同一个 WAL 库；
     * 两者并存会出现「长连接写 + 短连接开关」并发写同库。
     * 复用单例同时也让 overview 读到的就是投影方刚写下的状态。
     */
    const resolveSharedExtension = () => {
        try {
            const host = require('../../KnowledgeBaseManager')?.lifecycleExtensionHost;
            const shared = (host?.extensions || []).find(item => item instanceof MemoryRiverExtension && item.db);
            return shared || null;
        } catch (_) {
            return null;
        }
    };

    /**
     * 拿到可用扩展与对应的释放函数。命中单例时 release 是空操作 —— 路由绝不能关闭
     * 宿主的连接，否则后续生命周期事件会因 db 已关闭而全部投影失败。
     */
    const acquireExtension = async () => {
        const shared = resolveSharedExtension();
        if (shared) return { extension: shared, release: async () => {} };
        // 回落：扩展未启用或尚未初始化（如 KBM 还没 initialize）时仍让管理接口可读。
        const extension = new MemoryRiverExtension({ registryPath, databasePath });
        await extension.initialize();
        return { extension, release: () => extension.shutdown() };
    };

    router.get('/memory-river-extension/overview', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            const extension = acquired.extension;
            const projections = extension.db.prepare('SELECT river_id AS riverId, status, COUNT(*) AS count FROM memory_river_files GROUP BY river_id, status').all();
            const events = extension.db.prepare('SELECT status, COUNT(*) AS count FROM memory_river_events GROUP BY status').all();
            res.json({ principals: registry.listPrincipals(), diaries: registry.listDiaries(), rivers: registry.listRivers(), grants: registry.listGrants(), projections, events });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });

    const definitions = [
        ['principals', 'principal', 'principalId', 'listPrincipals', 'upsertPrincipal'],
        ['diaries', 'diary', 'diaryId', 'listDiaries', 'upsertDiary'],
        ['rivers', 'river', 'riverId', 'listRivers', 'upsertRiver'],
        ['grants', 'grant', 'grantId', 'listGrants', 'upsertGrant']
    ];
    for (const [plural, singular, key, list, upsert] of definitions) {
        router.get(`/memory-river-extension/${plural}`, (req, res) => { try { res.json({ [plural]: registry[list]() }); } catch (error) { sendError(res, error); } });
        router.post(`/memory-river-extension/${plural}`, (req, res) => { try { res.status(201).json({ [singular]: registry[upsert](req.body || {}) }); } catch (error) { sendError(res, error); } });
        router.put(`/memory-river-extension/${plural}/:id`, (req, res) => { try { res.json({ [singular]: registry[upsert]({ ...(req.body || {}), [key]: req.params.id }) }); } catch (error) { sendError(res, error); } });
    }

    /**
     * Ω 观测：按需触发，不挂在写入链上。
     * 单次观测要重建一遍 scoped 共现矩阵（本机 90 文件域约 9 万条边），
     * 成本与一次索引重建同量级，因此只允许显式 POST 触发。
     */
    router.post('/memory-river-extension/rivers/:riverId/observe', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            const kbm = require('../../KnowledgeBaseManager');
            const tagMemoEngine = kbm?.tagMemoEngine || null;
            if (!tagMemoEngine) {
                // 如实报缺而不是给一个 Ω=0：0 会被排名页当成「塌缩的河」。
                return res.status(503).json({ error: 'TagMemoEngine 未就绪，无法测量 Ω。', code: 'TAGMEMO_UNAVAILABLE' });
            }
            const { observeRiverOmega } = require('../../modules/memoryRiver/riverOmegaObserver');
            const observation = observeRiverOmega({
                extension: acquired.extension,
                tagMemoEngine,
                knowledgeBasePath: kbm.dbPath || path.join(process.cwd(), 'VectorStore', 'knowledge_base.sqlite'),
                riverId: req.params.riverId,
                seedLimit: Number(req.body?.seedLimit) > 0 ? Number(req.body.seedLimit) : undefined
            });
            res.json({ observation });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });

    /** 核心主页面：只取最新 Ω 数值。 */
    router.get('/memory-river-extension/rivers/:riverId/observability', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            res.json({ observation: acquired.extension.latestObservation(req.params.riverId) });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });

    /** 专用列表页：全部 River 的最新 Ω 排名，或单条 River 的历史序列。 */
    router.get('/memory-river-extension/observability', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            const extension = acquired.extension;
            if (req.query.riverId) {
                return res.json({ history: extension.listObservationHistory(req.query.riverId, Number(req.query.limit) || 50) });
            }
            res.json({ ranking: extension.listLatestObservations() });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });

    router.post('/memory-river-extension/migrate-v1', (req, res) => {
        try { const result = MemoryRiverRegistryV2.migrateFromV1(req.body?.v1Config || {}); if (req.body?.write === true) registry.save(result.config); res.json(result); } catch (error) { sendError(res, error); }
    });
    router.get('/memory-river-extension/rivers/:riverId/projections', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            const projections = acquired.extension.listProjections(req.params.riverId).filter(item => !req.query.status || item.status === req.query.status);
            res.json({ projections });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });
    router.get('/memory-river-extension/events', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            res.json({ events: acquired.extension.listEvents(req.query) });
        } catch (error) { sendError(res, error); } finally { await release(); }
    });
    // dead_letter 事件的人工重放：补登记漏掉的 diary 之后无需重建整库。
    router.post('/memory-river-extension/events/replay', async (req, res) => {
        let release = async () => {};
        try {
            const acquired = await acquireExtension();
            release = acquired.release;
            res.json(await acquired.extension.replayDeadLetters({ eventId: req.body?.eventId || null }));
        } catch (error) { sendError(res, error); } finally { await release(); }
    });
    router.post('/memory-river-extension/rebuild', async (req, res) => {
        if (req.body?.confirm !== true) return res.status(409).json({ error: 'Rebuild requires confirm=true', code: 'MEMORY_RIVER_REBUILD_CONFIRMATION_REQUIRED' });
        try {
            // 命中单例时把它交给重建器复用，避免第二个写连接争抢同一 WAL 库。
            res.json(await rebuildMemoryRiver({
                knowledgeBasePath: path.join(root, 'VectorStore', 'knowledge_base.sqlite'),
                registryPath,
                riverDatabasePath: databasePath,
                extension: resolveSharedExtension()
            }));
        } catch (error) { sendError(res, error); }
    });
    return router;
};
