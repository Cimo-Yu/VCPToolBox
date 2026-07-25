'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadKnowledgeLifecycleExtensions } = require('../modules/extensions/loadKnowledgeLifecycleExtensions');

test('loads configured extension factories without River-specific host code', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-extension-loader-'));
    const modulePath = path.join(directory, 'extension.js');
    fs.writeFileSync(modulePath, `module.exports.createKnowledgeLifecycleExtension = options => ({ options });`);

    const extensions = loadKnowledgeLifecycleExtensions({
        modulePaths: [modulePath],
        extensionOptions: { enabled: true },
        logger: { warn() {} }
    });

    assert.deepEqual(extensions, [{ options: { enabled: true } }]);
});

test('resolves a configured relative extension path from the project root', () => {
    const extensions = loadKnowledgeLifecycleExtensions({
        modulePaths: ['./extensions/memory-river'],
        projectRoot: path.resolve(__dirname, '..'),
        logger: { warn() {} }
    });

    assert.equal(extensions.length, 1);
    assert.equal(typeof extensions[0].handleKnowledgeLifecycleEvent, 'function');
});

test('skips an invalid configured extension instead of preventing startup', () => {
    const extensions = loadKnowledgeLifecycleExtensions({
        modulePaths: ['missing-extension-module'],
        logger: { warn() {} }
    });

    assert.deepEqual(extensions, []);
});
