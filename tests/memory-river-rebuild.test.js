'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { rebuildMemoryRiver } = require('../extensions/memory-river/scripts/rebuild-memory-river');

function makeTempDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-rebuild-'));
}

test('rebuilds River projections from KBM files without importing search engines', async () => {
    const directory = makeTempDirectory();
    const knowledgeBasePath = path.join(directory, 'knowledge-base.sqlite');
    const riverDatabasePath = path.join(directory, 'memory-river.sqlite');
    const configPath = path.join(directory, 'memory-rivers.json');
    const knowledgeBase = new Database(knowledgeBasePath);
    knowledgeBase.exec(`
        CREATE TABLE files (
            path TEXT PRIMARY KEY,
            diary_name TEXT NOT NULL,
            checksum TEXT,
            updated_at INTEGER
        );
    `);
    knowledgeBase.prepare(`
        INSERT INTO files (path, diary_name, checksum, updated_at)
        VALUES (?, ?, ?, ?)
    `).run('Diary/entry.md', 'Diary', 'rebuild-checksum', 123);
    knowledgeBase.close();
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        rivers: [{ id: 'diary-river', memoryScope: 'river:diary-river', diaries: ['Diary'] }]
    }));

    const result = await rebuildMemoryRiver({
        knowledgeBasePath,
        configPath,
        riverDatabasePath
    });

    assert.deepEqual(result, { scanned: 1, queued: 1, projected: 1 });
});
