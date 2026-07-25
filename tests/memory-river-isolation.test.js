'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createKnowledgeLifecycleExtension } = require('../extensions/memory-river');
const { KnowledgeLifecycleExtensionHost } = require('../modules/extensions/KnowledgeLifecycleExtensionHost');

test('a River extension failure leaves the KBM lifecycle publisher successful', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-isolation-'));
    const extension = createKnowledgeLifecycleExtension({
        configPath: path.join(directory, 'missing-config.json'),
        databasePath: path.join(directory, 'memory-river.sqlite'),
        logger: { warn() {} }
    });
    const host = new KnowledgeLifecycleExtensionHost({
        extensions: [extension],
        logger: { warn() {} }
    });

    await host.initialize();
    const event = await host.publish({
        type: 'knowledge.written',
        source: { filePath: 'Diary/entry.md', diaryName: 'Diary' },
        content: { text: '# entry' }
    });

    assert.equal(event.type, 'knowledge.written');
    await host.shutdown();
});
