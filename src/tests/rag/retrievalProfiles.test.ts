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
                reranker: {
                    model: 'reranker',
                    maxLength: 512,
                    batchSize: 8
                }
            }
        ]
    });

    const profile = resolveRetrievalProfile(config);
    assert.equal(profile.mode, 'hybrid');
    if (profile.mode === 'hybrid') {
        assert.equal(profile.sparseProfile, 'bm25-v1');
        assert.equal(profile.denseProfile, 'bge-m3-v1');
        assert.equal(profile.reranker?.maxLength, 512);
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
