'use strict';

const {
    computeRiverObservability
} = require('./modules/tagmemoV10/riverObservability');

let legacyNativeTopologyV3 = null;

function getLegacyNativeTopologyV3() {
    if (legacyNativeTopologyV3) return legacyNativeTopologyV3;
    const native = require('./rust-vexus-lite');
    if (typeof native.rerankRivermemoTopologyV3 !== 'function') {
        const error = new Error(
            'RiverMemo Topology V3 native kernel is unavailable; rebuild rust-vexus-lite.'
        );
        error.code = 'RIVERMEMO_NATIVE_TOPOLOGY_V3_UNAVAILABLE';
        throw error;
    }
    legacyNativeTopologyV3 = native.rerankRivermemoTopologyV3;
    return legacyNativeTopologyV3;
}

const VERSION = 'rivermemo_v1';
const ALGORITHM_VERSION = 'rivermemo.topology-v3.1';
const RESULT_SCHEMA = 'rivermemo-topology-v3-result-v1';

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function candidateId(candidate) {
    const id = Number(candidate?.id ?? candidate?.chunkId ?? candidate?.label);
    return Number.isFinite(id) && id > 0 ? id : null;
}

class RiverMemoEngine {
    constructor(v10Engine, options = {}) {
        if (!v10Engine) {
            throw new TypeError('RiverMemoEngine requires a TagMemoV10Engine runtime');
        }
        this.runtime = v10Engine;
        this.config = options.config || {};
        // 诊断标记：原生缓存按 Artifact 签名在首次成功请求时加载。
        // 这里只记录本门面观测到的状态，不复制或持有原生资产。
        this._nativeArtifactCacheObserved = false;
        this._nativeArtifactSigObserved = null;
    }

    updateConfig(config = {}) {
        this.config = config || {};
    }

    rebindDatabase(db) {
        this.runtime.rebindDatabase(db);
    }

    getArtifactSnapshot(options = {}) {
        return this.runtime.getArtifactSnapshot(options);
    }

    _computeAnchorScores(localDomain, curves) {
        const tagIds = Array.isArray(localDomain?.ids)
            ? [...new Set(localDomain.ids
                .map(Number)
                .filter(id => Number.isFinite(id) && id > 0))]
            : [];
        const chunkIds = [...new Set(
            (Array.isArray(curves) ? curves : [])
                .map(curve => Number(curve?.chunkId))
                .filter(id => Number.isFinite(id) && id > 0)
        )];
        const scores = new Map();
        if (tagIds.length === 0 || chunkIds.length === 0 || !this.runtime.db?.prepare) {
            return scores;
        }

        // 两组 IN 参数同时存在，使用保守的双层分块以兼容 SQLite 参数上限。
        // Tag 批次互不重叠，因此各批 COUNT(DISTINCT tag_id) 可以安全相加。
        const hitsByChunkId = new Map();
        const batchSize = 200;
        for (let tagOffset = 0; tagOffset < tagIds.length; tagOffset += batchSize) {
            const tagBatch = tagIds.slice(tagOffset, tagOffset + batchSize);
            const tagPlaceholders = tagBatch.map(() => '?').join(',');
            for (
                let chunkOffset = 0;
                chunkOffset < chunkIds.length;
                chunkOffset += batchSize
            ) {
                const chunkBatch = chunkIds.slice(
                    chunkOffset,
                    chunkOffset + batchSize
                );
                const chunkPlaceholders = chunkBatch.map(() => '?').join(',');
                const rows = this.runtime.db.prepare(`
                    SELECT c.id AS chunk_id,
                           COUNT(DISTINCT ft.tag_id) AS hits
                    FROM chunks c
                    JOIN file_tags ft ON ft.file_id = c.file_id
                    WHERE ft.tag_id IN (${tagPlaceholders})
                      AND c.id IN (${chunkPlaceholders})
                    GROUP BY c.id
                `).all(...tagBatch, ...chunkBatch);
                for (const row of rows) {
                    const chunkId = Number(row.chunk_id);
                    const hits = Math.max(0, Number(row.hits) || 0);
                    hitsByChunkId.set(
                        chunkId,
                        (hitsByChunkId.get(chunkId) || 0) + hits
                    );
                }
            }
        }

        const maximumHits = Math.max(0, ...hitsByChunkId.values());
        if (maximumHits <= 0) return scores;
        for (const [chunkId, hits] of hitsByChunkId.entries()) {
            scores.set(chunkId, hits / maximumHits);
        }
        return scores;
    }

    measureOmega(queryState, options = {}) {
        const artifact = options.artifact
            || this.runtime.getArtifactSnapshot({ buildIfMissing: false });
        const config = {
            ...(artifact?.effectiveConfig?.riverObservability || {}),
            ...(this.config?.riverObservability || {}),
            ...(options.config || {})
        };
        return computeRiverObservability(queryState, {
            ...config,
            structRoleMinOmega:
                options.structRoleMinOmega
                ?? artifact?.effectiveConfig?.dstc?.topologyV3StructRoleMinOmega
        });
    }

    _nativeConfig(artifact, options = {}) {
        const candidate = {
            ...(artifact.effectiveConfig?.candidateSuperset || {}),
            ...(this.config?.candidateSuperset || {}),
            ...(options.candidateSuperset || {})
        };
        const path = {
            ...(artifact.effectiveConfig?.pathGeometry || {}),
            ...(options.pathEvaluation || {})
        };
        const relative = {
            ...(artifact.effectiveConfig?.relativeTopology || {}),
            ...(options.pathEvaluation?.relativeTopology || {})
        };
        const omega = {
            ...(artifact.effectiveConfig?.riverObservability || {}),
            ...(this.config?.riverObservability || {}),
            ...(options.riverObservability || {})
        };
        const anchor = {
            ...(artifact.effectiveConfig?.directAnchor || {}),
            ...(this.config?.directAnchor || {})
        };
        const dstc = {
            ...(artifact.effectiveConfig?.dstc || {}),
            ...(options.dstc || {})
        };
        return {
            queryK: candidate.queryK,
            denoisedK: candidate.denoisedK ?? candidate.queryK,
            localFieldK: candidate.localFieldK,
            transferFieldK: candidate.transferFieldK,
            bm25K: candidate.bm25K,
            anchorK: candidate.anchorK,
            maxUnionCandidates: candidate.maxUnionCandidates,
            localWeight: path.localWeight,
            transferWeight: path.transferWeight,
            directionFloor: path.directionFloor,
            closureFloor: path.closureFloor,
            semanticNodeThreshold: relative.semanticNodeThreshold,
            relativeDistanceTemperature: relative.relativeDistanceTemperature,
            reverseDirectionCredit: relative.reverseDirectionCredit,
            minimumRiverEdgeFlow: relative.minimumRiverEdgeFlow,
            maximumRiverEdges: relative.maximumRiverEdges,
            nodeOnlyReliabilityCap: relative.nodeOnlyReliabilityCap,
            kappaEdge: omega.kappaEdge,
            kappaRatio: omega.kappaRatio,
            omegaEpsilon: omega.epsilon,
            collapsedThreshold: omega.collapsedThreshold,
            sparseThreshold: omega.sparseThreshold,
            semanticAnchorThreshold: anchor.semanticThreshold,
            semanticAnchorDiscount: anchor.semanticDiscount,
            specificityFloor: anchor.specificityFloor,
            rarityFloor: anchor.rarityFloor,
            reliabilitySeedSaturation: anchor.reliabilitySeedSaturation,
            fallbackReliabilityCap: anchor.fallbackReliabilityCap,
            topologyBonusCap: dstc.topologyBonusCap,
            topologyPathSaturation: dstc.topologyPathSaturation,
            conditionalBandwidth: dstc.topologyV2ConditionalBandwidth,
            conditionalClosureBandwidth: dstc.topologyV2ClosureBandwidth,
            conditionalDirectBandwidth: dstc.topologyV2DirectBandwidth,
            minimumPeers: dstc.topologyV2MinimumPeers,
            minimumEffectivePeers: dstc.topologyV2MinimumEffectivePeers,
            innovationConfidenceZ: dstc.topologyV2InnovationConfidenceZ,
            innovationScale: dstc.topologyV2InnovationScale,
            omegaGamma: dstc.topologyV3OmegaGamma,
            structRoleMinOmega: dstc.topologyV3StructRoleMinOmega,
            anchorBonusCap: dstc.topologyV3AnchorBonusCap,
            anchorActivationZ: dstc.topologyV3AnchorActivationZ,
            anchorActivationFloor: dstc.topologyV3AnchorActivationFloor,
            anchorSaturation: dstc.topologyV3AnchorSaturation,
            anchorFrontierContrast: dstc.topologyV3AnchorFrontierContrast,
            anchorFrontierAbsFloor: dstc.topologyV3AnchorFrontierAbsFloor
        };
    }

    async _rerankNative(query, inputCandidates, agentContext, options, artifact, prepared) {
        const queryState = prepared.queryState;
        const river = queryState.queryRiverGraph || {};
        const fieldProvenance = (
            Array.isArray(queryState.sourceObservation?.fieldProvenance)
                ? queryState.sourceObservation.fieldProvenance
                : []
        ).map(entry => ({
            id: Number(entry?.[0]),
            hop: Number(entry?.[1]?.hop) || 0,
            sourceType: String(entry?.[1]?.sourceType || '')
        }));
        const dbPath = String(
            options.dbPath
            || this.runtime.db?.name
            || this.runtime.db?.path
            || ''
        );
        if (!dbPath || dbPath === ':memory:') {
            const error = new Error(
                'RiverMemo native Topology V3 requires a file-backed SQLite database path.'
            );
            error.code = 'RIVERMEMO_NATIVE_DB_PATH_UNAVAILABLE';
            throw error;
        }

        const observationHandle = typeof options.observationHandle === 'string'
            && options.observationHandle
            ? options.observationHandle
            : null;
        const payload = {
            observationHandle,
            dimension: Number(this.runtime.config.dimension),
            topK: Math.max(
                1,
                Math.floor(Number(options.topK) || inputCandidates.length)
            ),
            includeTrace: options.includeTrace === true,
            query: {
                text: String(query?.text || ''),
                vector: observationHandle
                    ? []
                    : Array.from(query?.vector || options.vector || [])
            },
            denoisedVector: observationHandle
                ? []
                : Array.from(prepared.denoisedVector),
            localVector: Array.from(prepared.localVector),
            transferVector: Array.from(prepared.transferVector),
            candidates: inputCandidates.map(candidate => ({
                id: candidateId(candidate),
                score: Number(candidate.score) || 0,
                hybridScore: Number(candidate.hybridScore) || 0,
                vectorScore: Number(candidate.vectorScore) || 0,
                bm25Score: Number(candidate.bm25Score) || 0,
                anchorScore: Number(candidate.anchorScore) || 0
            })).filter(candidate => candidate.id !== null),
            queryState: {
                queryId: queryState.queryId,
                sourceField: observationHandle
                    ? []
                    : (queryState.sourceField || []),
                localField: queryState.localField || [],
                transferField: queryState.transferField || [],
                localDomainIds: queryState.localDomain?.ids || [],
                transferDomainIds: queryState.transferDomain?.ids || [],
                riverNodes: observationHandle
                    ? []
                    : (Array.isArray(river.nodes) ? river.nodes : []),
                riverEdges: observationHandle
                    ? []
                    : (Array.isArray(river.edges) ? river.edges : []),
                fieldProvenance: observationHandle ? [] : fieldProvenance,
                completeObservation: observationHandle
                    ? true
                    : queryState.sourceObservation?.diagnostics
                        ?.completeObservation === true
            },
            allowedFileIds: Array.isArray(agentContext.allowedFileIds)
                ? agentContext.allowedFileIds.map(Number).filter(Number.isFinite)
                : [],
            config: this._nativeConfig(artifact, options)
        };
        const nativeStartedAt = Date.now();
        const inputJson = JSON.stringify(payload);
        const tagIndex = this.runtime.tagIndex;
        const usesUnifiedMemoRuntime =
            typeof tagIndex?.rerankRivermemoTopologyV3 === 'function';
        const nativePayload = usesUnifiedMemoRuntime
            ? await tagIndex.rerankRivermemoTopologyV3(
                dbPath,
                artifact.artifactSig,
                inputJson
            )
            : await getLegacyNativeTopologyV3()(
                dbPath,
                artifact.artifactSig,
                inputJson
            );
        const nativeResult = JSON.parse(nativePayload);
        const memoRuntimeStats = usesUnifiedMemoRuntime
            && typeof tagIndex?.memoRuntimeStats === 'function'
            ? tagIndex.memoRuntimeStats()
            : null;
        this._nativeArtifactCacheObserved = true;
        this._nativeArtifactSigObserved = artifact.artifactSig;
        const inputById = new Map(
            inputCandidates
                .map(candidate => [candidateId(candidate), candidate])
                .filter(([id]) => id !== null)
        );
        const sourceObservation = queryState.sourceObservation || {};
        const queryMatchedTags = Object.freeze(
            [...new Set(
                (Array.isArray(sourceObservation.matchedTags)
                    ? sourceObservation.matchedTags
                    : [])
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean)
            )]
        );
        const queryCoreTagsMatched = Object.freeze(
            [...new Set(
                (Array.isArray(sourceObservation.coreTagsMatched)
                    ? sourceObservation.coreTagsMatched
                    : [])
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean)
            )]
        );
        const queryCoreTagSet = new Set(
            queryCoreTagsMatched.map(tag => tag.toLowerCase())
        );
        const includeTrace = options.includeTrace === true;
        const results = (Array.isArray(nativeResult.results)
            ? nativeResult.results
            : []
        ).map(item => {
            const original = inputById.get(Number(item.chunkId)) || {};
            const matchedTags = Object.freeze(
                [...new Set(
                    (Array.isArray(item.matchedTags) ? item.matchedTags : [])
                        .map(tag => String(tag || '').trim())
                        .filter(Boolean)
                )]
            );
            const stable = {
                ...original,
                id: Number(item.chunkId),
                chunkId: Number(item.chunkId),
                rank: Number(item.rank),
                score: clamp01(item.score),
                originalScore: Number(item.originalScore) || 0,
                baseScore: clamp01(item.baseScore),
                topologyBonus: clamp01(item.topologyBonus),
                anchorBonus: clamp01(item.anchorBonus),
                matchedTags,
                coreTagsMatched: Object.freeze(
                    matchedTags.filter(tag =>
                        queryCoreTagSet.has(tag.toLowerCase())
                    )
                ),
                tagMatchCount: matchedTags.length,
                role: item.role || 'thematic_neighbor',
                omega: clamp01(item.omega),
                riverRegime:
                    item.riverRegime
                    || nativeResult.omega?.regime
                    || 'collapsed',
                candidateSources: Object.freeze(
                    (Array.isArray(item.candidateSources)
                        ? item.candidateSources
                        : [])
                        .map(source => typeof source === 'string'
                            ? Object.freeze({ source })
                            : Object.freeze({ ...source }))
                )
            };
            if (!includeTrace) return Object.freeze(stable);
            return Object.freeze({
                ...stable,
                topologyV3: item.topologyV3 || null,
                topologyV2: null,
                relativeTopology: item.relativeTopology || null,
                geometry: item.geometry || null,
                observables: item.observables || null
            });
        });

        return Object.freeze({
            schema: RESULT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            artifactSig: artifact.artifactSig,
            artifactGeneration: artifact.generation,
            queryId: queryState.queryId,
            omega: Object.freeze(nativeResult.omega || {}),
            queryTags: Object.freeze({
                matchedTags: queryMatchedTags,
                coreTagsMatched: queryCoreTagsMatched,
                sourceMode: sourceObservation.sourceMode || null
            }),
            results: Object.freeze(results),
            diagnostics: Object.freeze({
                offeredCandidates: inputCandidates.length,
                projectedCandidates:
                    nativeResult.diagnostics?.projectedCandidates || 0,
                selectedCandidates:
                    nativeResult.diagnostics?.selectedCandidates || 0,
                rankedCandidates:
                    nativeResult.diagnostics?.rankedCandidates || 0,
                returnedCandidates: results.length,
                nativeTopologyV3: Object.freeze({
                    ...(nativeResult.diagnostics || {}),
                    ffiTotalMs: Date.now() - nativeStartedAt,
                    runtimeOwnership: usesUnifiedMemoRuntime
                        ? 'vexus-index-instance'
                        : 'legacy-module-cache',
                    memoRuntime: memoRuntimeStats
                        ? Object.freeze({ ...memoRuntimeStats })
                        : null
                }),
                exactDerivedAssets:
                    this.runtime.getDerivedAssetDiagnostics?.() || null,
                fieldProjection: prepared.fieldProjectionDiagnostics || null,
                preparationTimings: prepared.preparationTimings || null,
                field: queryState.fieldDiagnostics,
                queryProfile: Object.freeze({
                    mode: nativeResult.queryMode || null,
                    backend: 'rust-rayon'
                }),
                anchorBatchAvailable: true
            })
        });
    }

    _isRetiredArtifactError(error) {
        const message = String(error?.message || '');
        return error?.code === 'RIVERMEMO_ARTIFACT_UNAVAILABLE'
            || /RiverMemo artifact .* unavailable: Query returned no rows/i.test(message);
    }

    _refreshArtifactAfterRetirement(artifact) {
        if (typeof this.runtime?.invalidateArtifact === 'function') {
            this.runtime.invalidateArtifact(
                `native-artifact-unavailable:${artifact?.artifactSig || 'unknown'}`
            );
        }
        return this.runtime.getArtifactSnapshot({ forceRefresh: true });
    }

    async rerank(query, candidates, agentContext = {}, options = {}) {
        const rerankStartedAt = Date.now();
        const stageTimings = {};
        let stageStartedAt = rerankStartedAt;
        const markStage = name => {
            const now = Date.now();
            stageTimings[name] = now - stageStartedAt;
            stageStartedAt = now;
        };
        const inputCandidates = Array.isArray(candidates) ? candidates : [];
        if (inputCandidates.length === 0) {
            return Object.freeze({
                schema: RESULT_SCHEMA,
                version: VERSION,
                algorithmVersion: ALGORITHM_VERSION,
                artifactSig: null,
                queryId: null,
                omega: null,
                results: Object.freeze([]),
                diagnostics: Object.freeze({
                    offeredCandidates: 0,
                    rankedCandidates: 0,
                    reason: 'empty-candidate-set'
                })
            });
        }

        const artifact = options.artifact || this.runtime.getArtifactSnapshot();
        if (!artifact) {
            const error = new Error('RiverMemo artifact is unavailable');
            error.code = 'RIVERMEMO_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const queryVectorRaw = query?.vector || options.vector;
        const queryVector = queryVectorRaw instanceof Float32Array
            ? queryVectorRaw
            : new Float32Array(queryVectorRaw || []);
        if (queryVector.length !== Number(this.runtime.config.dimension)) {
            throw new RangeError(
                `RiverMemo query vector dimension must be ${this.runtime.config.dimension}, got ${queryVector.length}`
            );
        }

        // 生产统一管线已经在 Rust MemoRuntime 内完成 Local/Transfer
        // scaled-resolvent、有效支持域和向量投影。禁止再次调用 JS
        // prepareQuery()/solveQueryState() 持有并遍历第二份 CSR。
        const prepared = options.nativePreparedQuery || null;
        if (!prepared) {
            const error = new Error(
                'RiverMemo requires Rust-native prepared dual fields'
            );
            error.code = 'RIVERMEMO_NATIVE_DUAL_FIELDS_UNAVAILABLE';
            throw error;
        }
        markStage('prepareQueryMs');
        if (
            !prepared?.queryState
            || !prepared.denoisedVector
            || !prepared.localVector
            || !prepared.transferVector
        ) {
            const error = new Error('RiverMemo could not construct the continuous query fields');
            error.code = 'RIVERMEMO_QUERY_FIELD_UNAVAILABLE';
            throw error;
        }

        // Topology V3 的候选投影、路径几何、相对拓扑、DSTC、Direct Anchor、
        // 批级条件创新和最终排序全部由 Rust/Rayon 在一个 N-API 调用内完成。
        // JS 仅准备查询连续场并消费稳定结果，禁止再进入旧的逐候选计算链。
        try {
            return await this._rerankNative(
                query,
                inputCandidates,
                agentContext,
                options,
                artifact,
                prepared
            );
        } catch (error) {
            if (!this._isRetiredArtifactError(error)) throw error;
            const refreshedArtifact = this._refreshArtifactAfterRetirement(artifact);
            if (!refreshedArtifact || refreshedArtifact.artifactSig === artifact.artifactSig) {
                throw error;
            }
            console.warn(
                `[RiverMemo] Retrying once after retired artifact ${artifact.artifactSig}; ` +
                `using ${refreshedArtifact.artifactSig}.`
            );
            return await this._rerankNative(
                query,
                inputCandidates,
                agentContext,
                options,
                refreshedArtifact,
                prepared
            );
        }
    }
}

RiverMemoEngine.VERSION = VERSION;
RiverMemoEngine.ALGORITHM_VERSION = ALGORITHM_VERSION;
RiverMemoEngine.RESULT_SCHEMA = RESULT_SCHEMA;

module.exports = RiverMemoEngine;