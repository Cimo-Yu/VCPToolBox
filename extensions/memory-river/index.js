'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MemoryRiverRegistryV2 } = require('./MemoryRiverRegistryV2');

const STATUS_BY_EVENT_TYPE = Object.freeze({
    'knowledge.written': 'active',
    'knowledge.deleted': 'source_deleted',
    'knowledge.moved': 'moved',
    'knowledge.archived': 'archived',
    'knowledge.replaced': 'replaced'
});

function normalizeString(value, field) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new TypeError(`${field} is required`);
    return normalized;
}

class MemoryRiverRegistry {
    constructor(configPath) {
        this.configPath = configPath;
    }

    listRiversForDiary(diaryName) {
        if (!fs.existsSync(this.configPath)) return [];
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const target = normalizeString(diaryName, 'diaryName');
        return (Array.isArray(config.rivers) ? config.rivers : [])
            .filter(river => river?.enabled !== false && Array.isArray(river.diaries))
            .filter(river => river.diaries.includes(target))
            .map(river => ({
                riverId: normalizeString(river.id, 'river.id'),
                memoryScope: normalizeString(river.memoryScope || `river:${river.id}`, 'river.memoryScope')
            }));
    }
}

class MemoryRiverExtension {
    constructor({ configPath, registryPath, databasePath, createDefaultConfig = false, logger = console } = {}) {
        this.configPath = configPath || path.join(__dirname, 'config', 'memory-rivers.json');
        this.registryPath = registryPath || path.join(__dirname, 'config', 'memory-rivers.v2.json');
        this.databasePath = databasePath || path.join(__dirname, 'data', 'memory-river.sqlite');
        this.createDefaultConfig = createDefaultConfig;
        this.logger = logger;
        this.registry = new MemoryRiverRegistry(this.configPath);
        this.registryV2 = new MemoryRiverRegistryV2({ configPath: this.registryPath, createDefaultConfig });
        this.db = null;
    }

    _ensureDefaultConfig() {
        if (!this.createDefaultConfig || fs.existsSync(this.configPath)) return;
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
        try {
            fs.writeFileSync(this.configPath, `${JSON.stringify({ version: 1, rivers: [] }, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx'
            });
            this.logger.info?.(`[MemoryRiverExtension] Created default configuration at ${this.configPath}`);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    }

    async initialize() {
        if (this.db) return;
        this._ensureDefaultConfig();
        fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
        this.db = new Database(this.databasePath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_river_events (
                event_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS memory_river_files (
                river_id TEXT NOT NULL,
                memory_scope TEXT NOT NULL,
                file_path TEXT NOT NULL,
                diary_name TEXT,
                checksum TEXT,
                revision TEXT,
                status TEXT NOT NULL,
                PRIMARY KEY (river_id, file_path)
            );
        `);
    }

    async handleKnowledgeLifecycleEvent(event) {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        if (!STATUS_BY_EVENT_TYPE[event?.type]) return;
        const eventId = normalizeString(event.eventId, 'event.eventId');
        this.db.prepare(`
            INSERT OR IGNORE INTO memory_river_events (event_id, payload)
            VALUES (?, ?)
        `).run(eventId, JSON.stringify(event));
    }

    async drain() {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        const pending = this.db.prepare(`
            SELECT event_id, payload FROM memory_river_events
            WHERE status = 'pending'
            ORDER BY rowid
        `).all();
        for (const row of pending) this._applyPendingEvent(row);
    }

    _applyPendingEvent(row) {
        try {
            const event = JSON.parse(row.payload);
            const source = event.source || {};
            const filePath = normalizeString(source.filePath, 'event.source.filePath');
            const diaryName = normalizeString(source.diaryName, 'event.source.diaryName');
            const status = STATUS_BY_EVENT_TYPE[event.type];
            const rivers = fs.existsSync(this.registryPath)
                ? this.registryV2.findRiversForDiary(diaryName)
                : this.registry.listRiversForDiary(diaryName);
            const apply = this.db.transaction(() => {
                for (const river of rivers) {
                    this.db.prepare(`
                        INSERT INTO memory_river_files (
                            river_id, memory_scope, file_path, diary_name, checksum, revision, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(river_id, file_path) DO UPDATE SET
                            memory_scope = excluded.memory_scope,
                            diary_name = excluded.diary_name,
                            checksum = COALESCE(excluded.checksum, memory_river_files.checksum),
                            revision = COALESCE(excluded.revision, memory_river_files.revision),
                            status = excluded.status
                    `).run(
                        river.riverId || river.id,
                        river.memoryScope,
                        filePath,
                        diaryName,
                        source.checksum || null,
                        source.revision || null,
                        status
                    );
                }
                this.db.prepare(`
                    UPDATE memory_river_events
                    SET status = 'complete', attempts = attempts + 1, last_error = NULL
                    WHERE event_id = ?
                `).run(row.event_id);
            });
            apply();
        } catch (error) {
            this.db.prepare(`
                UPDATE memory_river_events
                SET attempts = attempts + 1, last_error = ?
                WHERE event_id = ?
            `).run(String(error.message || error), row.event_id);
            this.logger.warn?.(`[MemoryRiverExtension] event ${row.event_id} was retained for retry: ${error.message || error}`);
        }
    }

    listProjections(riverId) {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT river_id AS riverId, memory_scope AS memoryScope, file_path AS filePath,
                   diary_name AS diaryName, checksum, revision, status
            FROM memory_river_files
            WHERE river_id = ?
            ORDER BY file_path
        `).all(riverId);
    }

    listEvents({ status, limit = 100, offset = 0 } = {}) {
        if (!this.db) return [];
        const values = [];
        const filter = status ? 'WHERE status = ?' : '';
        if (status) values.push(status);
        values.push(Math.max(1, Math.min(Number(limit) || 100, 500)), Math.max(0, Number(offset) || 0));
        return this.db.prepare(`
            SELECT event_id AS eventId, payload, status, attempts, last_error AS lastError
            FROM memory_river_events ${filter}
            ORDER BY rowid DESC LIMIT ? OFFSET ?
        `).all(...values).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    }

    async shutdown() {
        if (!this.db) return;
        this.db.close();
        this.db = null;
    }
}

function createKnowledgeLifecycleExtension(options = {}) {
    return new MemoryRiverExtension(options);
}

module.exports = {
    createKnowledgeLifecycleExtension,
    MemoryRiverExtension,
    MemoryRiverRegistry,
    STATUS_BY_EVENT_TYPE
};
