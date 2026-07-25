'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const RiverMemoEngine = require('../RiverMemoEngine');

function nativePreparedQuery() {
    return {
        queryState: {},
        denoisedVector: [1],
        localVector: [1],
        transferVector: [1]
    };
}

test('retries once with a fresh ready artifact when native RiverMemo rejects a retired artifact', async () => {
    const retiredArtifact = { artifactSig: 'retired-artifact' };
    const readyArtifact = { artifactSig: 'ready-artifact' };
    let snapshots = 0;
    const runtime = {
        config: { dimension: 2 },
        getArtifactSnapshot({ forceRefresh } = {}) {
            snapshots += 1;
            if (forceRefresh) return readyArtifact;
            return retiredArtifact;
        }
    };
    const engine = new RiverMemoEngine(runtime);
    const attemptedArtifacts = [];
    engine._rerankNative = async (_query, _candidates, _context, _options, artifact) => {
        attemptedArtifacts.push(artifact.artifactSig);
        if (artifact.artifactSig === 'retired-artifact') {
            const error = new Error('RiverMemo artifact retired-artifact unavailable: Query returned no rows');
            error.code = 'RIVERMEMO_ARTIFACT_UNAVAILABLE';
            throw error;
        }
        return { results: [] };
    };

    const result = await engine.rerank(
        { vector: new Float32Array([1, 0]) },
        [{ id: 1 }],
        {},
        { nativePreparedQuery: nativePreparedQuery() }
    );

    assert.deepEqual(result, { results: [] });
    assert.deepEqual(attemptedArtifacts, ['retired-artifact', 'ready-artifact']);
    assert.equal(snapshots, 2);
});

test('does not retry an unrelated native RiverMemo failure', async () => {
    const artifact = { artifactSig: 'ready-artifact' };
    const runtime = {
        config: { dimension: 2 },
        getArtifactSnapshot() {
            return artifact;
        }
    };
    const engine = new RiverMemoEngine(runtime);
    let attempts = 0;
    engine._rerankNative = async () => {
        attempts += 1;
        throw new Error('native topology timed out');
    };

    await assert.rejects(
        engine.rerank(
            { vector: new Float32Array([1, 0]) },
            [{ id: 1 }],
            {},
            { nativePreparedQuery: nativePreparedQuery() }
        ),
        /native topology timed out/
    );
    assert.equal(attempts, 1);
});
