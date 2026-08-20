'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MemoryRiverRegistryV2 } = require('./MemoryRiverRegistryV2');
const { RelationRiverRouter } = require('./RelationRiverRouter');

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
    constructor({ configPath, registryPath, databasePath, createDefaultConfig = false, maxAttempts, logger = console } = {}) {
        this.configPath = configPath || path.join(__dirname, 'config', 'memory-rivers.json');
        this.registryPath = registryPath || path.join(__dirname, 'config', 'memory-rivers.v2.json');
        // 调用方是否显式点名 v2 registry。
        // 不能用「默认 v2 文件是否存在」来判定：仓库内恒有该文件，
        // 那样任何只传 configPath 的调用方都会被静默路由到与自己无关的默认 registry，
        // 结果是投影 0 行且不报错。
        this.registryPathExplicit = Boolean(registryPath);
        this.configPathExplicit = Boolean(configPath);
        this.databasePath = databasePath || path.join(__dirname, 'data', 'memory-river.sqlite');
        this.createDefaultConfig = createDefaultConfig;
        this.logger = logger;
        // 重试预算：达到后事件转 dead_letter，不再自动重试。
        this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
        this.registry = new MemoryRiverRegistry(this.configPath);
        this.registryV2 = new MemoryRiverRegistryV2({ configPath: this.registryPath, createDefaultConfig });
        // 关系河路由只在 v2 上成立（层间关系挂在 river.metadata 上，v1 没有该字段）。
        this.relationRiverRouter = new RelationRiverRouter({ registry: this.registryV2, logger: this.logger });
        this.db = null;
    }

    /**
     * 解析某个日记归属的 River 列表。
     *
     * 路由优先级按「调用方意图」而非「文件是否存在」：
     *   1. 显式传入 registryPath → 只用 v2；
     *   2. 只显式传入 configPath  → 只用 v1（避免被仓库内默认 v2 registry 劫持）；
     *   3. 两者都未指定         → 优先 v2，其存在但无匹配时回落 v1。
     * 若最终无任何归属，记一条告警：投影 0 行是需要排查的配置问题，不该静默通过。
     */
    _usesV2Registry() {
        return this.registryPathExplicit
            || (!this.configPathExplicit && fs.existsSync(this.registryPath));
    }

    _resolveRiversForDiary(diaryName) {
        const useV2 = this._usesV2Registry();

        let rivers = [];
        if (useV2) {
            rivers = this.registryV2.findRiversForDiary(diaryName) || [];
            if (rivers.length === 0 && !this.registryPathExplicit) {
                rivers = this.registry.listRiversForDiary(diaryName) || [];
            }
        } else {
            rivers = this.registry.listRiversForDiary(diaryName) || [];
        }

        if (rivers.length === 0) {
            this.logger?.warn?.(
                `[MemoryRiverExtension] 日记 "${diaryName}" 未匹配到任何 River，`
                + `本次事件不产生投影（registry=${useV2 ? 'v2' : 'v1'}）。`
            );
        }
        return rivers;
    }

    /**
     * 在基础路由之外追加第 2 层有向关系河。
     *
     * 基础路由只认文件夹名，因此「诺娃的日记本」永远只落进 nova-self；
     * 但一篇写了 `[在场::小绝]` 的日记同时也是「诺娃对小绝」的素材。
     * 这里按正文标记补上那些目标，纯正则推导，不调用 LLM ——
     * 写日记是 Agent 自主行为，投影环节过一次模型就等于隐式唤醒了推理。
     *
     * 只在 v2 路由下生效，且失败一律降级为「无追加目标」：
     * 关系河是富化投影，它的问题不该让自我河的基础投影一起失败。
     */
    _resolveRelationRivers(diaryName, text, useV2) {
        if (!useV2 || !text) return [];
        try {
            return this.relationRiverRouter.resolveRelationRivers({ diaryName, text });
        } catch (error) {
            this.logger?.warn?.(
                `[MemoryRiverExtension] 关系河推导失败，仅保留基础投影: ${error.message || error}`
            );
            return [];
        }
    }

    /**
     * 该文件已有的投影目标。
     *
     * 状态变更事件（archived / deleted / moved / replaced）不带正文，
     * 因此无法重新推导关系河。若只按基础路由更新，关系河那条投影会永远停在
     * active —— 源文件已归档，读取侧却仍把它当在流通的记忆。
     * 靠 (river_id, file_path) 主键回查既有行，状态就能传播到当初落过的每一处。
     */
    _resolveExistingProjectionRivers(filePath) {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT river_id AS riverId, memory_scope AS memoryScope
            FROM memory_river_files WHERE file_path = ?
        `).all(filePath);
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
            /*
             * Ω 观测独立成表，不复用 memory_river_files：
             * 后者主键是 (river_id, file_path)、粒度是「每文件一行」，
             * 而 Ω 是「每 River 每次观测一行」；塞进去只能重复 90 行同一个 Ω，
             * 或者伪造一个哨兵 file_path 污染投影语义。
             * 且投影表是 drain 的独占写面（单写者纪律），观测不该去争它。
             * 排名页需要历史，measured_at 进主键即可天然保留多次观测。
             */
            CREATE TABLE IF NOT EXISTS memory_river_observations (
                river_id TEXT NOT NULL,
                measured_at INTEGER NOT NULL,
                omega REAL NOT NULL,
                edge_activation REAL,
                emergence REAL,
                flow_entropy REAL,
                active_edges INTEGER,
                seed_nodes INTEGER,
                reached_nodes INTEGER,
                emergent_nodes INTEGER,
                regime TEXT,
                guidance TEXT,
                complete_observation INTEGER NOT NULL DEFAULT 1,
                raw TEXT,
                PRIMARY KEY (river_id, measured_at)
            );
        `);
        // 上一次运行遗留或 River SQLite 曾不可用期间堆积的 pending 事件，
        // 只有在启动时消费才会恢复；否则它们会一直停留在 inbox 里。
        try {
            await this.drain();
        } catch (error) {
            this.logger?.warn?.(
                `[MemoryRiverExtension] startup drain failed; pending events retained: ${error.message || error}`
            );
        }
    }

    async handleKnowledgeLifecycleEvent(event) {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        if (!STATUS_BY_EVENT_TYPE[event?.type]) return;
        const eventId = normalizeString(event.eventId, 'event.eventId');
        this.db.prepare(`
            INSERT OR IGNORE INTO memory_river_events (event_id, payload)
            VALUES (?, ?)
        `).run(eventId, JSON.stringify(event));
        // 入 inbox 之后必须立即消费，否则投影表永远为空而所有接口仍返回 200，
        // 表现为“配置像是错的”而非“消费没发生”。
        // drain 自身已逐事件隔离异常，这里再兜一层：投影失败不能让 KBM 写入链看到错误。
        try {
            await this.drain();
        } catch (error) {
            this.logger?.warn?.(
                `[MemoryRiverExtension] inline drain failed after ${eventId}; event stays pending: ${error.message || error}`
            );
        }
    }

    async drain() {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        // 只取尚未超出重试预算的 pending。否则一条永久损坏的事件（缺 diaryName 等）
        // 会在此后每次事件到达时被重试，随 inbox 增长变成持续的无用功。
        const pending = this.db.prepare(`
            SELECT event_id, payload FROM memory_river_events
            WHERE status = 'pending' AND attempts < ?
            ORDER BY rowid
        `).all(this.maxAttempts);
        for (const row of pending) this._applyPendingEvent(row);
    }

    _applyPendingEvent(row) {
        try {
            const event = JSON.parse(row.payload);
            const source = event.source || {};
            const filePath = normalizeString(source.filePath, 'event.source.filePath');
            const diaryName = normalizeString(source.diaryName, 'event.source.diaryName');
            const status = STATUS_BY_EVENT_TYPE[event.type];
            const baseRivers = this._resolveRiversForDiary(diaryName);
            // 正文只有 knowledge.written 带（见 modules/knowledgeBase/ingestionPipeline.js
            // 的 content: { text: doc.content }）。删除/归档事件没有正文可读，
            // 此时只更新既有投影行的 status，不新增关系河目标。
            const relationRivers = this._resolveRelationRivers(
                diaryName, event.content?.text, this._usesV2Registry()
            );
            // 去重按 riverId：基础路由、关系河与既有投影三者可能指向同一条河，
            // 投影表主键是 (river_id, file_path)，重复只会白跑一次 upsert。
            const seen = new Set();
            const rivers = [
                ...baseRivers,
                ...relationRivers,
                ...this._resolveExistingProjectionRivers(filePath)
            ].filter(item => {
                const key = item.riverId || item.id;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
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
            // 达到预算即转 dead_letter：保留 payload 与 last_error 供接口查询和人工重放，
            // 但不再参与自动重试。
            const exhausted = this.db.prepare(`
                UPDATE memory_river_events
                SET attempts = attempts + 1,
                    last_error = ?,
                    status = CASE WHEN attempts + 1 >= ? THEN 'dead_letter' ELSE status END
                WHERE event_id = ?
                RETURNING status
            `).get(String(error.message || error), this.maxAttempts, row.event_id);
            const detail = `${error.message || error}`;
            if (exhausted?.status === 'dead_letter') {
                this.logger?.error?.(
                    `[MemoryRiverExtension] event ${row.event_id} moved to dead_letter after ${this.maxAttempts} attempts: ${detail}`
                );
            } else {
                this.logger?.warn?.(`[MemoryRiverExtension] event ${row.event_id} was retained for retry: ${detail}`);
            }
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

    /**
     * 落盘一次 Ω 观测。probe 结果是 frozen 对象，这里只读不改。
     * measured_at 由调用方传入：脚本环境里 Date.now 可用，
     * 但留成参数便于测试注入固定时刻，也避免同一毫秒重复主键。
     */
    recordObservation(probe, measuredAt) {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        const riverId = normalizeString(probe?.riverId, 'probe.riverId');
        // 不能写成 Number.isFinite(Number(measuredAt))：Number(null) === 0 是有限值，
        // 省略参数时会把观测时刻记成 1970，排名页的历史顺序随即失效。
        const stamp = measuredAt === null || measuredAt === undefined || !Number.isFinite(Number(measuredAt))
            ? Date.now()
            : Number(measuredAt);
        const components = probe.components || {};
        const counts = probe.counts || {};
        this.db.prepare(`
            INSERT OR REPLACE INTO memory_river_observations (
                river_id, measured_at, omega, edge_activation, emergence, flow_entropy,
                active_edges, seed_nodes, reached_nodes, emergent_nodes,
                regime, guidance, complete_observation, raw
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            riverId, stamp, Number(probe.omega) || 0,
            components.edgeActivation ?? null, components.emergence ?? null, components.flowEntropy ?? null,
            counts.activeEdges ?? null, counts.seedNodes ?? null, counts.reachedNodes ?? null, counts.emergentNodes ?? null,
            probe.regime ?? null,
            // guidance 是 {trust, hint} 对象，better-sqlite3 只接受标量，
            // 直接绑定会报 "Too few parameter values" 这类误导性错误。
            probe.guidance ? JSON.stringify(probe.guidance) : null,
            probe.completeObservation === false ? 0 : 1,
            probe.raw ? JSON.stringify(probe.raw) : null
        );
        return { riverId, measuredAt: stamp, omega: Number(probe.omega) || 0 };
    }

    /** guidance 以 JSON 文本落盘，读出来必须还原成对象，否则前端拿到的是裸字符串。 */
    static _hydrateObservation(row) {
        if (!row) return row;
        if (typeof row.guidance === 'string') {
            try {
                row.guidance = JSON.parse(row.guidance);
            } catch {
                // 旧行可能存的是纯 regime 文本，保持原样比抛错更有用。
            }
        }
        if (row.completeObservation !== undefined) {
            row.completeObservation = !!row.completeObservation;
        }
        return row;
    }

    /** 单个 River 的最新一次观测；核心主页面只需要这个数值。 */
    latestObservation(riverId) {
        if (!this.db) return null;
        const row = this.db.prepare(`
            SELECT river_id AS riverId, measured_at AS measuredAt, omega,
                   edge_activation AS edgeActivation, emergence, flow_entropy AS flowEntropy,
                   active_edges AS activeEdges, seed_nodes AS seedNodes,
                   reached_nodes AS reachedNodes, emergent_nodes AS emergentNodes,
                   regime, guidance, complete_observation AS completeObservation
            FROM memory_river_observations WHERE river_id = ?
            ORDER BY measured_at DESC LIMIT 1
        `).get(riverId) || null;
        return MemoryRiverExtension._hydrateObservation(row);
    }

    /**
     * 每个 River 取最新一次观测后排序 —— 排名页的数据源。
     * 排序沿用 rankRiversForDispatch 的口径：omega 降序，同分看 emergence。
     */
    listLatestObservations() {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT o.river_id AS riverId, o.measured_at AS measuredAt, o.omega,
                   o.edge_activation AS edgeActivation, o.emergence, o.flow_entropy AS flowEntropy,
                   o.active_edges AS activeEdges, o.seed_nodes AS seedNodes,
                   o.reached_nodes AS reachedNodes, o.emergent_nodes AS emergentNodes,
                   o.regime, o.guidance, o.complete_observation AS completeObservation
            FROM memory_river_observations o
            JOIN (SELECT river_id, MAX(measured_at) AS latest FROM memory_river_observations GROUP BY river_id) m
              ON m.river_id = o.river_id AND m.latest = o.measured_at
            ORDER BY o.omega DESC, o.emergence DESC
        `).all().map(row => MemoryRiverExtension._hydrateObservation(row));
    }

    /** 单个 River 的观测历史，供排名页看趋势。 */
    listObservationHistory(riverId, { limit = 50 } = {}) {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT river_id AS riverId, measured_at AS measuredAt, omega,
                   emergence, regime, complete_observation AS completeObservation
            FROM memory_river_observations WHERE river_id = ?
            ORDER BY measured_at DESC LIMIT ?
        `).all(riverId, Math.max(1, Math.min(Number(limit) || 50, 500)));
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

    /**
     * 把 dead-letter 事件放回 pending 并立即重试一次。
     * 用于「配置修好之后恢复历史事件」：登记漏掉的 diary 后无需重建整库。
     *
     * @param {object} [options] `options.eventId` 只重放单条；省略则重放全部 dead-letter。
     * @returns {Promise<object>} 重放条数与重放后仍未完成的条数
     */
    async replayDeadLetters({ eventId = null } = {}) {
        if (!this.db) throw new Error('MemoryRiverExtension is not initialized');
        const reset = eventId
            ? this.db.prepare(`UPDATE memory_river_events SET status = 'pending', attempts = 0 WHERE event_id = ? AND status = 'dead_letter'`).run(eventId)
            : this.db.prepare(`UPDATE memory_river_events SET status = 'pending', attempts = 0 WHERE status = 'dead_letter'`).run();
        await this.drain();
        const stillPending = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_river_events WHERE status IN ('pending', 'dead_letter')`).get()?.count || 0;
        return { replayed: reset.changes, stillPending };
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
