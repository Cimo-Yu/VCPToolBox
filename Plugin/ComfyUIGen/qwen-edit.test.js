const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { prepareWorkflowImages, fillWorkflowParameters } = require('./ComfyUIGen');

test('Qwen T2I and single/dual edit templates preserve graph, cache node and numeric parameters', () => {
    const genTemplate = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflows', 'qwen21gen.json')));
    const genGraph = fillWorkflowParameters(genTemplate.workflow, {
        prompt: 'This is an RGBA format image with transparency. Cute bunny maid.',
        seed: '42'
    }, {
        userSettings: {
            qualityTags: 'masterpiece, best quality',
            negativePrompt: 'lowres, bad hands',
            ...genTemplate.defaults
        }
    });
    assert.equal(genGraph['452'].inputs.prompt, 'This is an RGBA format image with transparency. Cute bunny maid.');
    assert.equal(genGraph['452'].inputs.negative_prompt, '');
    assert.equal(genGraph['452'].inputs.resolution, 1024);
    assert.equal(genGraph['469'].class_type, 'QwenImage21Cache');
    assert.deepEqual(genGraph['458'].inputs.model, ['469', 0]);
    assert.equal(genGraph['458'].inputs.steps, 30);
    assert.equal(genGraph['458'].inputs.cfg, 1);
    assert.equal(genGraph['458'].inputs.seed, 42);
    assert.ok(!JSON.stringify(genGraph).includes('{{'));

    const gen2k = fillWorkflowParameters(genTemplate.workflow, {
        prompt: '2K poster',
        negative_prompt: 'blurry',
        width: '2048',
        height: '2048',
        resolution: '2048',
        cfg: '4.0',
        steps: '25'
    }, { userSettings: genTemplate.defaults });
    assert.equal(gen2k['456'].inputs.width, 2048);
    assert.equal(gen2k['456'].inputs.height, 2048);
    assert.equal(gen2k['452'].inputs.resolution, 2048);
    assert.equal(gen2k['452'].inputs.negative_prompt, 'blurry');
    assert.equal(gen2k['458'].inputs.cfg, 4);
    assert.equal(gen2k['458'].inputs.steps, 25);

    for (const name of ['qwen21edit', 'qwen21edit2in1']) {
        const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflows', `${name}.json`)));
        const graph = fillWorkflowParameters(template.workflow, {
            prompt: '使用图1主体和图2背景', image: 'one.png', image_2: 'two.png', seed: '0'
        }, { userSettings: template.defaults });
        assert.equal(graph['458'].inputs.steps, 8);
        assert.equal(graph['458'].inputs.cfg, 1);
        assert.equal(graph['458'].inputs.seed, 0);
        assert.equal(graph['474'].inputs.resolution, 0);
        assert.deepEqual(graph['458'].inputs.latent_image, ['474', 2]);
        assert.equal(graph['470'].inputs.image, 'one.png');
        if (name.endsWith('2in1')) assert.equal(graph['477'].inputs.image, 'two.png');
        assert.ok(!JSON.stringify(graph).includes('{{'));
        for (const node of Object.values(graph)) {
            for (const value of Object.values(node.inputs)) {
                if (Array.isArray(value)) assert.ok(graph[value[0]], `missing ${value[0]}`);
            }
        }
        const overridden = fillWorkflowParameters(template.workflow, {
            prompt: 'edit', steps: '12', cfg: '0', resolution: '1024'
        }, { userSettings: template.defaults });
        assert.equal(overridden['458'].inputs.steps, 12);
        assert.equal(overridden['458'].inputs.cfg, 0);
        assert.equal(overridden['474'].inputs.resolution, 1024);
    }
});
test('HTTP images upload separately; filenames pass through; invalid images fail', async () => {
    let uploads = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=', 'base64');
    const server = http.createServer(async (req, res) => {
        if (req.url === '/picture') { res.end(png); return; }
        if (req.url === '/upload/image') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            assert.match(req.headers['content-type'], /multipart\/form-data; boundary=/);
            assert.ok(body.includes(png));
            assert.match(body.toString(), /name="type"/);
            uploads++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ name: `image${uploads}.png`, subfolder: 'vcp' }));
            return;
        }
        res.end('<html>not an image</html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-qwen-'));
    const localImage = path.join(tempDir, '追踪 图片.png');
    fs.writeFileSync(localImage, png);
    try {
        const config = { COMFYUI_BASE_URL: base };
        const args = { image: `${base}/picture`, image_2: `${base}/picture` };
        const prepared = await prepareWorkflowImages(args, ['image', 'image_2'], config);
        assert.equal(prepared.image, 'vcp/image1.png');
        assert.equal(prepared.image_2, 'vcp/image2.png');
        assert.equal(args.image, `${base}/picture`);
        assert.equal(uploads, 2);
        assert.equal((await prepareWorkflowImages({ image: 'existing.png' }, ['image'], config)).image, 'existing.png');
        await assert.rejects(prepareWorkflowImages({}, ['image'], config), /requires/);
        await assert.rejects(prepareWorkflowImages({ image: `${base}/bad` }, ['image'], config), /PNG/);
        await assert.rejects(prepareWorkflowImages({ image: pathToFileURL(path.join(tempDir, 'missing.png')).href }, ['image'], config), /file tracing/);
        await assert.rejects(prepareWorkflowImages({ image: 'file://remote/share.png' }, ['image'], config), /network share/);
        await assert.rejects(prepareWorkflowImages({ image: '../test.png' }, ['image'], config), /must be/);
        assert.equal(uploads, 2);
        const fromFile = await prepareWorkflowImages({ image: pathToFileURL(localImage).href }, ['image'], config);
        assert.equal(fromFile.image, 'vcp/image3.png');
        assert.equal(uploads, 3);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        await new Promise(resolve => server.close(resolve));
    }
});
test('ComfyUIGen JEV manifest validates and plans qwen21gen / qwen21edit / qwen21edit2in1 with dual URLs', async () => {
    const { JevThirdPartyRegistry } = require('../../modules/jevThirdPartyRegistry');
    const { JevToolCallExp } = require('../../modules/jevToolCallExp');

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin-manifest.json'), 'utf8'));
    const registry = new JevThirdPartyRegistry();
    registry.build([{ manifest, enabled: true, origin: 'local' }]);
    const entry = registry.getEntry('ComfyUIGen');
    assert.equal(entry.validation.status, 'valid', JSON.stringify(entry.validation.errors));
    const planner = new JevToolCallExp({
        thirdPartyRegistry: registry,
        jevClient: { isConfigured: () => false },
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });

    const [t2iCall] = await planner.plan(
        '请使用 {媒体娱乐} 中的 `ComfyUIGen`，生成插画【商业二次元展会宣传海报，兔娘女仆】[工作流:qwen21gen][宽:2048][高:2048][分辨率:2048][cfg:4.0][负面:blurry]。'
    );
    assert.equal(t2iCall.name, 'ComfyUIGen');
    assert.equal(t2iCall.args.workflow, 'qwen21gen');
    assert.equal(t2iCall.args.width, '2048');
    assert.equal(t2iCall.args.height, '2048');
    assert.equal(t2iCall.args.resolution, '2048');
    assert.equal(t2iCall.args.cfg, '4.0');
    assert.equal(t2iCall.args.negative_prompt, 'blurry');

    const [dualEditCall] = await planner.plan(
        '请使用 {媒体娱乐} 中的 `ComfyUIGen`，双图合成【使用图1的人物和图2的雨夜街道场景，统一冷色调光影】[工作流:qwen21edit2in1][http://127.0.0.1:6015/person.png][http://127.0.0.1:6015/scene.png][步数:8]。'
    );
    assert.equal(dualEditCall.name, 'ComfyUIGen');
    assert.equal(dualEditCall.args.workflow, 'qwen21edit2in1');
    assert.equal(dualEditCall.args.image, 'http://127.0.0.1:6015/person.png');
    assert.equal(dualEditCall.args.image_2, 'http://127.0.0.1:6015/scene.png');
    assert.equal(dualEditCall.args.steps, '8');
});