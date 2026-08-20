'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MemoryRiverRegistryV2 } = require('../extensions/memory-river/MemoryRiverRegistryV2');

function registry() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-registry-v2-'));
    return new MemoryRiverRegistryV2({ configPath: path.join(directory, 'memory-rivers.v2.json') });
}

test('maps an owned diary to its enabled River', () => {
    const subject = registry();
    subject.upsertPrincipal({ principalId: 'vcpchat:aria', displayName: 'Aria' });
    subject.upsertDiary({ diaryId: 'diary:daily', diaryName: 'Daily', ownerPrincipalId: 'vcpchat:aria', source: { folder: 'Daily' } });
    subject.upsertRiver({ riverId: 'daily-river', name: 'Daily River', memoryScope: 'river:daily', diaryIds: ['diary:daily'] });
    subject.upsertGrant({ principalId: 'vcpchat:aria', riverId: 'daily-river', permissions: ['read_own'] });

    assert.deepEqual(subject.findRiversForDiary('Daily'), [{ riverId: 'daily-river', memoryScope: 'river:daily' }]);
    assert.deepEqual(subject.resolveAuthorizedDiarySet({ principalId: 'vcpchat:aria', riverId: 'daily-river' }).diaryNames, ['Daily']);
});

test('rejects two owners for one physical diary folder', () => {
    const subject = registry();
    subject.upsertPrincipal({ principalId: 'vcpchat:a' });
    subject.upsertPrincipal({ principalId: 'vcpchat:b' });
    subject.upsertDiary({ diaryId: 'diary:a', diaryName: 'Diary', ownerPrincipalId: 'vcpchat:a', source: { folder: 'Diary' } });

    assert.throws(() => subject.upsertDiary({ diaryId: 'diary:b', diaryName: 'Diary', ownerPrincipalId: 'vcpchat:b', source: { folder: 'Diary' } }), /already owned/i);
});

test('derives an ASCII diaryId for CJK diary folders', () => {
    const subject = registry();
    subject.upsertPrincipal({ principalId: 'vcpchat:_Agent_1772950828995_1772950828996' });
    const owner = 'vcpchat:_Agent_1772950828995_1772950828996';

    // 真实日记本文件夹是中文；派生 id 必须是 ASCII，中文只留在 diaryName / source.folder。
    const created = subject.upsertDiary({ ownerPrincipalId: owner, folder: 'Ariadne知识日记本' });
    assert.match(created.diaryId, /^diary:[0-9a-f]{12}$/);
    assert.equal(created.diaryName, 'Ariadne知识日记本');
    assert.equal(created.source.folder, 'Ariadne知识日记本');

    // 同一物理文件夹重复登记必须得到同一 id，否则每次保存都会新增一条 diary。
    assert.equal(subject.upsertDiary({ ownerPrincipalId: owner, folder: 'Ariadne知识日记本' }).diaryId, created.diaryId);
    assert.notEqual(subject.upsertDiary({ ownerPrincipalId: owner, folder: '决策官日记本' }).diaryId, created.diaryId);

    subject.upsertRiver({ riverId: 'cjk-river', diaryIds: [created.diaryId] });
    assert.deepEqual(subject.findRiversForDiary('Ariadne知识日记本'), [{ riverId: 'cjk-river', memoryScope: 'river:cjk-river' }]);
});

test('shares one River across multiple agent diaries under observe', () => {
    const subject = registry();
    const agents = [['vcpchat:nova', '诺娃'], ['vcpchat:jue', '小绝'], ['vcpchat:coco', '可可']];
    const diaryIds = [];
    for (const [principalId, displayName] of agents) {
        subject.upsertPrincipal({ principalId, displayName });
        // 每个 agent 写自己 owner 的公共日常文件夹：文件夹归属真实，
        // 同时满足「一个物理文件夹只能有一个 owner」。
        diaryIds.push(subject.upsertDiary({ ownerPrincipalId: principalId, folder: `${displayName}的公共日常` }).diaryId);
    }
    subject.upsertRiver({ riverId: 'public-daily-river', name: '公共日常河', diaryIds });
    for (const [principalId] of agents) subject.upsertGrant({ principalId, riverId: 'public-daily-river', permissions: ['observe'] });

    // 河道本身无 owner，observe 下每个成员都读到全河，而非各自那一份。
    const expected = ['诺娃的公共日常', '小绝的公共日常', '可可的公共日常'];
    for (const [principalId] of agents) {
        const resolved = subject.resolveAuthorizedDiarySet({ principalId, riverId: 'public-daily-river' });
        assert.equal(resolved.scope, 'observe');
        assert.deepEqual(resolved.diaryNames, expected);
    }
});

test('keeps read_own scoped to the principal own diaries inside a shared River', () => {
    const subject = registry();
    subject.upsertPrincipal({ principalId: 'vcpchat:nova', displayName: '诺娃' });
    subject.upsertPrincipal({ principalId: 'vcpchat:jue', displayName: '小绝' });
    const own = subject.upsertDiary({ ownerPrincipalId: 'vcpchat:nova', folder: '诺娃的日记本' }).diaryId;
    const other = subject.upsertDiary({ ownerPrincipalId: 'vcpchat:jue', folder: '小绝的日记本' }).diaryId;
    subject.upsertRiver({ riverId: 'mixed-river', name: '混合河', diaryIds: [own, other] });
    subject.upsertGrant({ principalId: 'vcpchat:nova', riverId: 'mixed-river', permissions: ['read_own'] });

    // read_own 是自我河语义，aesthetics-river 依赖它：河内仍只读自己 owner 的 diary。
    const resolved = subject.resolveAuthorizedDiarySet({ principalId: 'vcpchat:nova', riverId: 'mixed-river' });
    assert.equal(resolved.scope, 'read_own');
    assert.deepEqual(resolved.diaryNames, ['诺娃的日记本']);

    // 两权限并存时取 observe 的全域。
    subject.upsertGrant({ grantId: 'grant:nova:mixed:observe', principalId: 'vcpchat:nova', riverId: 'mixed-river', permissions: ['read_own', 'observe'] });
    assert.deepEqual(subject.resolveAuthorizedDiarySet({ principalId: 'vcpchat:nova', riverId: 'mixed-river' }).diaryNames, ['诺娃的日记本', '小绝的日记本']);
});

test('fails closed when a principal holds neither read_own nor observe', () => {
    const subject = registry();
    subject.upsertPrincipal({ principalId: 'vcpchat:nova' });
    const diaryId = subject.upsertDiary({ ownerPrincipalId: 'vcpchat:nova', folder: '诺娃的日记本' }).diaryId;
    subject.upsertRiver({ riverId: 'closed-river', name: '闭合河', diaryIds: [diaryId] });
    // contribute 不含读权限，不得因主体是 owner 就放行。
    subject.upsertGrant({ principalId: 'vcpchat:nova', riverId: 'closed-river', permissions: ['contribute'] });

    assert.throws(() => subject.resolveAuthorizedDiarySet({ principalId: 'vcpchat:nova', riverId: 'closed-river' }), error => error.code === 'GRANT_INSUFFICIENT' && error.statusCode === 403);
    assert.throws(() => subject.resolveAuthorizedDiarySet({ principalId: 'vcpchat:nova', riverId: 'ghost-river' }), error => error.code === 'GRANT_INSUFFICIENT');
});

test('previews legacy River diary mappings without guessing owners', () => {
    const migration = MemoryRiverRegistryV2.migrateFromV1({ version: 1, rivers: [{ id: 'legacy', diaries: ['Unassigned'] }] });
    assert.equal(migration.config.version, 2);
    assert.deepEqual(migration.config.rivers[0].diaryIds, []);
    assert.deepEqual(migration.unresolvedDiaries, ['Unassigned']);
});
