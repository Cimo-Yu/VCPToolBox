'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const { MemoryRiverExtension } = require('..');

/**
 * @param {object} options
 * @param {object} [options.extension] 已初始化的扩展实例。传入时复用其连接并且不予关闭，
 *   避免与宿主单例同时写同一个 WAL 库而触发 SQLITE_BUSY。
 */
async function rebuildMemoryRiver({ knowledgeBasePath, configPath, registryPath, riverDatabasePath, extension: sharedExtension = null }) {
    const knowledgeBase = new Database(knowledgeBasePath, { readonly: true });
    const extension = sharedExtension
        || new MemoryRiverExtension({ configPath, registryPath, databasePath: riverDatabasePath });
    let scanned = 0;
    let queued = 0;

    try {
        if (!sharedExtension) await extension.initialize();
        const files = knowledgeBase.prepare(`
            SELECT path, diary_name AS diaryName, checksum, updated_at AS revision
            FROM files
            ORDER BY path
        `).all();
        scanned = files.length;
        for (const file of files) {
            const eventId = `rebuild:${file.path}:${file.checksum || file.revision || ''}`;
            await extension.handleKnowledgeLifecycleEvent({
                version: 1,
                eventId,
                type: 'knowledge.written',
                occurredAt: new Date().toISOString(),
                source: {
                    filePath: file.path,
                    diaryName: file.diaryName,
                    checksum: file.checksum || undefined,
                    revision: file.revision === null || file.revision === undefined
                        ? undefined
                        : String(file.revision)
                },
                content: { text: '' }
            });
            queued += 1;
        }
        await extension.drain();
        const projected = extension.db.prepare(
            'SELECT COUNT(*) AS count FROM memory_river_files'
        ).get().count;
        return { scanned, queued, projected };
    } finally {
        knowledgeBase.close();
        // 复用宿主实例时绝不关闭：关闭会让后续生命周期事件全部投影失败。
        if (!sharedExtension) await extension.shutdown();
    }
}

if (require.main === module) {
    const [knowledgeBasePath, configPath, riverDatabasePath] = process.argv.slice(2);
    if (!knowledgeBasePath || !configPath || !riverDatabasePath) {
        console.error(
            'Usage: node rebuild-memory-river.js <knowledge-base.sqlite> <memory-rivers.json> <memory-river.sqlite>'
        );
        process.exitCode = 1;
    } else {
        rebuildMemoryRiver({ knowledgeBasePath, configPath, riverDatabasePath })
            .then(result => console.log(JSON.stringify(result)))
            .catch(error => {
                console.error(error.stack || error);
                process.exitCode = 1;
            });
    }
}

module.exports = { rebuildMemoryRiver };
