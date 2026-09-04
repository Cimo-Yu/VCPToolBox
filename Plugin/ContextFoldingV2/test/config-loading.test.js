const assert = require('assert');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const foldingPlugin = require('../ContextFoldingV2.js');

async function run() {
    // 期望值从插件自身 config.env 读取，避免测试与配置再次漂移
    const envPath = path.join(__dirname, '..', 'config.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
    const expectedModel = parsed.FOLDING_SUMMARY_MODEL;
    assert.ok(expectedModel, 'config.env 必须定义 FOLDING_SUMMARY_MODEL');

    const originalModel = process.env.FOLDING_SUMMARY_MODEL;
    process.env.FOLDING_SUMMARY_MODEL = 'inherited-process-model';

    try {
        await foldingPlugin.initialize({}, {
            contextBridge: {
                version: 'test',
                foldingStore: { getStats: () => ({ available: false }) }
            }
        });

        assert.strictEqual(
            foldingPlugin.summaryModel,
            expectedModel,
            'plugin-local FOLDING_SUMMARY_MODEL should take precedence over process.env'
        );
        assert.ok(
            foldingPlugin.summarySystemPrompt.startsWith('上下文压缩器。'),
            'summarySystemPrompt should start with the local system prompt content'
        );
        assert.ok(
            foldingPlugin.summarySystemPrompt.includes('[VCP上下文语义折叠-本层摘要:摘要内容]'),
            'summarySystemPrompt should include the exact instruction marker'
        );
        assert.ok(
            !foldingPlugin.summarySystemPrompt.startsWith('FOLDING_SUMMARY_SYSTEM_PROMPT='),
            'summarySystemPrompt should not include the dotenv assignment prefix'
        );
    } finally {
        if (originalModel === undefined) delete process.env.FOLDING_SUMMARY_MODEL;
        else process.env.FOLDING_SUMMARY_MODEL = originalModel;
        if (foldingPlugin._ragParamsWatcher) await foldingPlugin._ragParamsWatcher.close();
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
