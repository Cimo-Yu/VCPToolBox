'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..', 'Plugin', 'VSearch');
const PLUGIN_ENTRY = path.join(PLUGIN_DIR, 'VSearch.js');
const {
    resolveSearchMode,
    describeAvailability,
    resolveProxy,
    buildSearchOutcome,
    MODE_PRIORITY,
} = require(PLUGIN_ENTRY);

// --- 模式选择 ---

test('显式指定的模式原样返回，即使它没配置', () => {
    // 调用方点名了后端就必须用那个后端。偷偷换成别的会让"我明明指定了 grok"
    // 这类问题彻底无法排查，宁可让它自己报缺配置的错。
    const picked = resolveSearchMode('grok', { grok: false, tavily: true });
    assert.equal(picked.mode, 'grok');
    assert.equal(picked.explicit, true);
});

test('未指定模式时跳过没配置的后端', () => {
    // 出厂默认是 kimisearch（见 Plugin/VSearch/config.env.example:11），
    // 但没人配 KimiSearchKey 时它会秒败——默认值必须落在真的能跑的后端上。
    const picked = resolveSearchMode(undefined, { kimisearch: false, tavily: true });
    assert.equal(picked.mode, 'tavily');
    assert.equal(picked.explicit, false);
});

test('未指定模式且全都没配置时返回 null 由调用方给可操作错误', () => {
    const picked = resolveSearchMode('', {});
    assert.equal(picked.mode, null);
});

test('自动选择遵循 MODE_PRIORITY 的顺序', () => {
    assert.deepEqual(MODE_PRIORITY, ['kimisearch', 'tavily', 'grounding', 'grok']);
    const picked = resolveSearchMode(undefined, { kimisearch: true, tavily: true, grounding: true });
    assert.equal(picked.mode, 'kimisearch');
});

test('可用性按各模式真正必需的键判定', () => {
    const availability = describeAvailability({
        kimiKey: 'k', kimiUrl: 'u',
        tavilyKey: '',
        apiKey: 'a', apiUrl: 'b', model: '',
    });
    assert.equal(availability.kimisearch, true);
    assert.equal(availability.tavily, false);
    // grounding 还需要 VSearchModel，grok 只需要端点+key。
    assert.equal(availability.grounding, false);
    assert.equal(availability.grok, true);
});

// --- 代理来源 ---

test('代理读取 HTTP_PROXY 优先，HTTPS_PROXY 兜底', () => {
    // 插件自己的 example 第 5 节写的是 HTTP_PROXY，而根 config.env 用的是
    // HTTPS_PROXY，两边从没对齐过，导致 resolveRedirect 永远拿不到代理。
    assert.equal(resolveProxy({ HTTP_PROXY: 'http://a', HTTPS_PROXY: 'http://b' }), 'http://a');
    assert.equal(resolveProxy({ HTTPS_PROXY: 'http://b' }), 'http://b');
    assert.equal(resolveProxy({ https_proxy: 'http://c' }), 'http://c');
    assert.equal(resolveProxy({}), undefined);
});

// --- 全失败不能报成功 ---

test('全部关键词失败时产出 error 而不是 success', () => {
    // 旧行为：代理挂掉时正文写着"搜索失败"，status 仍是 success，
    // 于是既不进 PluginManager 的 ERROR 日志，AI 也会当成"没搜到"。
    const outcome = buildSearchOutcome({
        modeLabel: 'Tavily', topic: 't', report: '### 关键词: x\n[搜索失败]: boom\n',
        okCount: 0, total: 2, firstError: 'boom',
    });
    assert.equal(outcome.status, 'error');
    assert.match(outcome.error, /全部 2 个关键词/);
    assert.match(outcome.error, /boom/);
});

test('部分成功仍然是 success，报告完整返回', () => {
    const outcome = buildSearchOutcome({
        modeLabel: 'Tavily', topic: '主题', report: 'BODY',
        okCount: 1, total: 2, firstError: 'boom',
    });
    assert.equal(outcome.status, 'success');
    const text = outcome.result.content[0].text;
    assert.match(text, /\[模式: Tavily\]/);
    assert.match(text, /BODY/);
});

// --- 子进程级：真实入口行为 ---

const runPlugin = (request, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLUGIN_ENTRY], {
        cwd: PLUGIN_DIR,
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            windir: process.env.windir,
            ...env,
        },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', () => {
        try {
            resolve({ payload: JSON.parse(stdout), stderr });
        } catch (e) {
            reject(new Error(`stdout 不是 JSON: ${stdout.slice(0, 200)} / stderr: ${stderr.slice(0, 300)}`));
        }
    });
    child.stdin.end(JSON.stringify(request));
});

test('什么都没配置时给出点名缺哪些键的错误', async () => {
    // 用空的根 config.env 和空的插件 config.env 隔离本机真实凭据，否则断言会被
    // 根目录/插件目录里已有的 TavilyKey、KimiSearchKey 带跑（VSearch.js 同样支持
    // VSEARCH_PLUGIN_CONFIG 覆盖插件自身配置路径，专门给测试用）。
    const emptyRoot = path.join(os.tmpdir(), `vsearch-empty-${process.pid}.env`);
    const emptyPlugin = path.join(os.tmpdir(), `vsearch-plugin-empty-${process.pid}.env`);
    fs.writeFileSync(emptyRoot, '# 故意留空\n');
    fs.writeFileSync(emptyPlugin, '# 故意留空\n');
    try {
        const { payload } = await runPlugin(
            { SearchTopic: 't', Keywords: 'k' },
            { VSEARCH_ROOT_CONFIG: emptyRoot, VSEARCH_PLUGIN_CONFIG: emptyPlugin },
        );
        assert.equal(payload.status, 'error');
        assert.match(payload.error, /KimiSearchKey|TavilyKey|VSearchUrl/);
    } finally {
        fs.rmSync(emptyRoot, { force: true });
        fs.rmSync(emptyPlugin, { force: true });
    }
});

test('kimisearch 全部关键词连接失败时返回 error', async () => {
    const { payload } = await runPlugin(
        { SearchTopic: 't', Keywords: 'a,b', SearchMode: 'kimisearch' },
        { KimiSearchKey: 'dummy', KimiSearchUrl: 'http://127.0.0.1:1' },
    );
    assert.equal(payload.status, 'error');
    assert.match(payload.error, /全部 2 个关键词/);
});
