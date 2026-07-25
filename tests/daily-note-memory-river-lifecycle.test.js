'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    publishArchivedSources
} = require('../Plugin/DailyNoteManager/daily-note-manager');

test('publishes one archived lifecycle event for each successfully organized source', async () => {
    const received = [];
    await publishArchivedSources({
        _publishKnowledgeLifecycleEvent: async event => received.push(event)
    }, [{
        sourcePath: 'D:/notes/Diary/entry.md',
        diaryName: 'Diary',
        checksum: 'checksum-1'
    }], 'D:/notes');

    assert.deepEqual(received, [{
        type: 'knowledge.archived',
        source: {
            filePath: 'Diary/entry.md',
            diaryName: 'Diary',
            checksum: 'checksum-1'
        }
    }]);
});

test('does nothing when the KBM lifecycle publisher is unavailable', async () => {
    await publishArchivedSources({}, [{
        sourcePath: 'D:/notes/Diary/entry.md', diaryName: 'Diary'
    }], 'D:/notes');
    assert.ok(true);
});
