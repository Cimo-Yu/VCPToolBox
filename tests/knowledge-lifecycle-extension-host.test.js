'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    KnowledgeLifecycleExtensionHost
} = require('../modules/extensions/KnowledgeLifecycleExtensionHost');

test('publishes a normalized written event after a knowledge write', async () => {
    const received = [];
    const host = new KnowledgeLifecycleExtensionHost({
        extensions: [{
            async handleKnowledgeLifecycleEvent(event) {
                received.push(event);
            }
        }]
    });

    await host.publish({
        type: 'knowledge.written',
        source: {
            filePath: 'Diary/entry.md',
            diaryName: 'Diary',
            checksum: 'abc123'
        },
        content: { text: '# entry' }
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].version, 1);
    assert.equal(received[0].type, 'knowledge.written');
    assert.equal(received[0].source.filePath, 'Diary/entry.md');
    assert.ok(received[0].eventId);
    assert.ok(received[0].occurredAt);
});

test('isolates extension failures from other extensions', async () => {
    let delivered = false;
    const host = new KnowledgeLifecycleExtensionHost({
        extensions: [{
            async handleKnowledgeLifecycleEvent() {
                throw new Error('extension failure');
            }
        }, {
            async handleKnowledgeLifecycleEvent() {
                delivered = true;
            }
        }],
        logger: { warn() {} }
    });

    await host.publish({
        type: 'knowledge.deleted',
        source: { filePath: 'Diary/entry.md', diaryName: 'Diary' }
    });

    assert.equal(delivered, true);
});

test('calls extension initialization and shutdown without making either fatal', async () => {
    const calls = [];
    const host = new KnowledgeLifecycleExtensionHost({
        extensions: [{
            async initialize(context) {
                calls.push(context.knowledgeBase);
            },
            async shutdown() {
                calls.push('shutdown');
            }
        }]
    });
    const knowledgeBase = {};

    await host.initialize({ knowledgeBase });
    await host.shutdown();

    assert.deepEqual(calls, [knowledgeBase, 'shutdown']);
});

test('KBM lifecycle publisher isolates extension host failures', async () => {
    const KnowledgeBaseManager = require('../KnowledgeBaseManager').constructor;
    const calls = [];
    const manager = {
        lifecycleExtensionHost: {
            async publish(event) {
                calls.push(event);
                throw new Error('extension unavailable');
            }
        }
    };

    await KnowledgeBaseManager.prototype._publishKnowledgeLifecycleEvent.call(manager, {
        type: 'knowledge.deleted',
        source: { filePath: 'Diary/entry.md', diaryName: 'Diary' }
    });

    assert.equal(calls.length, 1);
});
