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

test('previews legacy River diary mappings without guessing owners', () => {
    const migration = MemoryRiverRegistryV2.migrateFromV1({ version: 1, rivers: [{ id: 'legacy', diaries: ['Unassigned'] }] });
    assert.equal(migration.config.version, 2);
    assert.deepEqual(migration.config.rivers[0].diaryIds, []);
    assert.deepEqual(migration.unresolvedDiaries, ['Unassigned']);
});
