import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetrievalProfilesConfig, resolveRetrievalProfile } from '../../rag/retrievalProfiles.js';

test('retrieval profiles keep physical indexes separate from hybrid strategy', () => {
    const config = parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [
            {
                id: 'hybrid-v1',
                mode: 'hybrid',
                sparseProfile: 'bm25-v1',
                denseProfile: 'bge-m3-v1',
                candidateLimitPerRetriever: 100,
                fusionLimit: 100,
                rrfK: 60,
                candidateCacheDir: 'var/cache/candidates',
                rerankDocumentMode: 'metadata-prefixed',
                sourceLocalSearch: {
                    sourceLimit: 20,
                    candidateLimitPerSource: 4,
                    chunksPerSource: 1,
                    rankingMode: 'source-preserving',
                    anchorMode: 'source-aggregate'
                },
                chunkRerankFusionWeight: 0.8,
                evidenceRerankFusionWeight: 0.6,
                stages: {
                    evidenceRerank: false,
                    sourceLimit: true
                },
                reranker: {
                    model: 'reranker',
                    maxLength: 512,
                    batchSize: 8,
                    scoreCacheDir: 'var/cache/scores'
                }
            }
        ]
    });

    const profile = resolveRetrievalProfile(config);
    assert.equal(profile.mode, 'hybrid');
    if (profile.mode === 'hybrid') {
        assert.equal(profile.sparseProfile, 'bm25-v1');
        assert.equal(profile.denseProfile, 'bge-m3-v1');
        assert.equal(profile.candidateCacheDir, 'var/cache/candidates');
        assert.equal(profile.rerankDocumentMode, 'metadata-prefixed');
        assert.deepEqual(profile.sourceLocalSearch, {
            sourceLimit: 20,
            candidateLimitPerSource: 4,
            chunksPerSource: 1,
            rankingMode: 'source-preserving',
            anchorMode: 'source-aggregate'
        });
        assert.equal(profile.chunkRerankFusionWeight, 0.8);
        assert.equal(profile.evidenceRerankFusionWeight, 0.6);
        assert.equal(profile.stages?.evidenceRerank, false);
        assert.equal(profile.stages?.sourceLimit, true);
        assert.equal(profile.reranker?.maxLength, 512);
        assert.equal(profile.reranker?.scoreCacheDir, 'var/cache/scores');
    }
});

test('retrieval profiles reject missing active profile', () => {
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'missing',
        profiles: [{
            id: 'bm25-v1',
            mode: 'single',
            indexProfile: 'bm25-v1',
            candidateLimit: 20
        }]
    }), /active retrieval profile does not exist/);
});

test('single retrieval profile supports reranking', () => {
    const config = parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'bm25-rerank-v1',
        profiles: [{
            id: 'bm25-rerank-v1',
            mode: 'single',
            indexProfile: 'bm25-v1',
            candidateLimit: 100,
            reranker: {
                model: 'reranker',
                maxLength: 512,
                batchSize: 8
            }
        }]
    });

    const profile = resolveRetrievalProfile(config);
    assert.equal(profile.mode, 'single');
    if (profile.mode === 'single') {
        assert.equal(profile.candidateLimit, 100);
        assert.equal(profile.reranker?.model, 'reranker');
    }
});

test('retrieval profiles reject invalid fusion weights and stage flags', () => {
    const hybrid = {
        id: 'hybrid-v1',
        mode: 'hybrid',
        sparseProfile: 'bm25-v1',
        denseProfile: 'dense-v1',
        candidateLimitPerRetriever: 100,
        fusionLimit: 100,
        rrfK: 60
    };
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{ ...hybrid, chunkRerankFusionWeight: 1.1 }]
    }), /between 0 and 1/);
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{ ...hybrid, stages: { evidenceRerank: 'false' } }]
    }), /must be a boolean/);
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{ ...hybrid, rerankDocumentMode: 'metadata-only' }]
    }), /must be one of/);
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{
            ...hybrid,
            sourceLocalSearch: { sourceLimit: 20, candidateLimitPerSource: 0, chunksPerSource: 1 }
        }]
    }), /must be a positive integer/);
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{
            ...hybrid,
            sourceLocalSearch: {
                sourceLimit: 20,
                candidateLimitPerSource: 4,
                chunksPerSource: 1,
                rankingMode: 'source-only'
            }
        }]
    }), /must be one of/);
    assert.throws(() => parseRetrievalProfilesConfig({
        activeRetrievalProfile: 'hybrid-v1',
        profiles: [{
            ...hybrid,
            sourceLocalSearch: {
                sourceLimit: 20,
                candidateLimitPerSource: 4,
                chunksPerSource: 1,
                anchorMode: 'local-and-global'
            }
        }]
    }), /must be one of/);
});
