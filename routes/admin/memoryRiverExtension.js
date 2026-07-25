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
    const openExtension = () => new MemoryRiverExtension({ registryPath, databasePath });

    router.get('/memory-river-extension/overview', async (req, res) => {
        const extension = openExtension();
        try {
            await extension.initialize();
            const projections = extension.db.prepare('SELECT river_id AS riverId, status, COUNT(*) AS count FROM memory_river_files GROUP BY river_id, status').all();
            const events = extension.db.prepare('SELECT status, COUNT(*) AS count FROM memory_river_events GROUP BY status').all();
            res.json({ principals: registry.listPrincipals(), diaries: registry.listDiaries(), rivers: registry.listRivers(), grants: registry.listGrants(), projections, events });
        } catch (error) { sendError(res, error); } finally { await extension.shutdown(); }
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

    router.post('/memory-river-extension/migrate-v1', (req, res) => {
        try { const result = MemoryRiverRegistryV2.migrateFromV1(req.body?.v1Config || {}); if (req.body?.write === true) registry.save(result.config); res.json(result); } catch (error) { sendError(res, error); }
    });
    router.get('/memory-river-extension/rivers/:riverId/projections', async (req, res) => {
        const extension = openExtension();
        try { await extension.initialize(); const projections = extension.listProjections(req.params.riverId).filter(item => !req.query.status || item.status === req.query.status); res.json({ projections }); } catch (error) { sendError(res, error); } finally { await extension.shutdown(); }
    });
    router.get('/memory-river-extension/events', async (req, res) => {
        const extension = openExtension();
        try { await extension.initialize(); res.json({ events: extension.listEvents(req.query) }); } catch (error) { sendError(res, error); } finally { await extension.shutdown(); }
    });
    router.post('/memory-river-extension/rebuild', async (req, res) => {
        if (req.body?.confirm !== true) return res.status(409).json({ error: 'Rebuild requires confirm=true', code: 'MEMORY_RIVER_REBUILD_CONFIRMATION_REQUIRED' });
        try { res.json(await rebuildMemoryRiver({ knowledgeBasePath: path.join(root, 'VectorStore', 'knowledge_base.sqlite'), registryPath, riverDatabasePath: databasePath })); } catch (error) { sendError(res, error); }
    });
    return router;
};
