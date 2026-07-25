'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MemoryRiverExtension } = require('../extensions/memory-river');

function makeTempDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-extension-'));
}

function writeConfig(directory) {
    const configPath = path.join(directory, 'memory-rivers.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        rivers: [{
            id: 'diary-river',
            memoryScope: 'river:diary-river',
            diaries: ['Diary'],
            enabled: true
        }]
    }), 'utf8');
    return configPath;
}

function createExtension(directory) {
    return new MemoryRiverExtension({
        configPath: writeConfig(directory),
        databasePath: path.join(directory, 'memory-river.sqlite')
    });
}

function writtenEvent(eventId = 'write-1') {
    return {
        version: 1,
        eventId,
        type: 'knowledge.written',
        occurredAt: new Date().toISOString(),
        source: {
            filePath: 'Diary/entry.md',
            diaryName: 'Diary',
            checksum: 'checksum-1',
            revision: '1'
        },
        content: { text: '# title' }
    };
}

test('projects a lifecycle event through its Registry v2 diary mapping', async () => {
    const directory = makeTempDirectory();
    const registryPath = path.join(directory, 'memory-rivers.v2.json');
    fs.writeFileSync(registryPath, JSON.stringify({
        version: 2,
        principals: [{ principalId: 'vcpchat:aria' }],
        diaries: [{ diaryId: 'diary:daily', diaryName: 'Diary', ownerPrincipalId: 'vcpchat:aria', source: { folder: 'Diary' } }],
        rivers: [{ riverId: 'registry-river', memoryScope: 'river:registry', diaryIds: ['diary:daily'] }],
        grants: [{ principalId: 'vcpchat:aria', riverId: 'registry-river', permissions: ['read_own'] }]
    }), 'utf8');
    const extension = new MemoryRiverExtension({ registryPath, databasePath: path.join(directory, 'memory-river.sqlite') });

    await extension.initialize();
    await extension.handleKnowledgeLifecycleEvent(writtenEvent());
    await extension.drain();

    assert.equal(extension.listProjections('registry-river')[0].status, 'active');
    await extension.shutdown();
});

test('creates an empty default configuration on first initialization', async () => {
    const directory = makeTempDirectory();
    const configPath = path.join(directory, 'config', 'memory-rivers.json');
    const extension = new MemoryRiverExtension({
        configPath,
        databasePath: path.join(directory, 'data', 'memory-river.sqlite'),
        createDefaultConfig: true
    });

    await extension.initialize();

    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
        version: 1,
        rivers: []
    });
    await extension.shutdown();
});

test('projects an eligible write into only its configured River', async () => {
    const extension = createExtension(makeTempDirectory());
    await extension.initialize();
    await extension.handleKnowledgeLifecycleEvent(writtenEvent());
    await extension.drain();

    assert.deepEqual(extension.listProjections('diary-river'), [{
        riverId: 'diary-river', memoryScope: 'river:diary-river',
        filePath: 'Diary/entry.md', diaryName: 'Diary', checksum: 'checksum-1',
        revision: '1', status: 'active'
    }]);
    await extension.shutdown();
});

test('marks a projected file as source_deleted without touching KBM data', async () => {
    const extension = createExtension(makeTempDirectory());
    await extension.initialize();
    await extension.handleKnowledgeLifecycleEvent(writtenEvent());
    await extension.handleKnowledgeLifecycleEvent({
        ...writtenEvent('delete-1'), type: 'knowledge.deleted', content: {}
    });
    await extension.drain();

    assert.equal(extension.listProjections('diary-river')[0].status, 'source_deleted');
    await extension.shutdown();
});

test('does not create a projection for an unconfigured diary', async () => {
    const extension = createExtension(makeTempDirectory());
    await extension.initialize();
    await extension.handleKnowledgeLifecycleEvent({
        ...writtenEvent(), source: { filePath: 'Other/entry.md', diaryName: 'Other' }
    });
    await extension.drain();

    assert.deepEqual(extension.listProjections('diary-river'), []);
    await extension.shutdown();
});

test('records moved lifecycle state as a River-local projection', async () => {
    const extension = createExtension(makeTempDirectory());
    await extension.initialize();
    await extension.handleKnowledgeLifecycleEvent({
        ...writtenEvent('move-1'), type: 'knowledge.moved', content: {}
    });
    await extension.drain();

    assert.equal(extension.listProjections('diary-river')[0].status, 'moved');
    await extension.shutdown();
});
