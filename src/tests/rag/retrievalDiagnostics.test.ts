import assert from 'node:assert/strict';
import test from 'node:test';
import { retrievalManagedResultTraceAttributes } from '../../rag/retrievalDiagnostics.js';

test('managed retrieval diagnostics expose match count, latency, and index identity', () => {
    const attributes = retrievalManagedResultTraceAttributes([{
        id: 'source.md#1',
        source: 'source.md',
        score: 0.9
    }], 12.6, {
        retrievalProfile: 'balanced-v1',
        variant: 'raw-wiki',
        indexes: [{
            profile: 'bm25-v1',
            profileFingerprint: 'profile-sha',
            chunkFingerprint: 'chunk-sha'
        }]
    });

    assert.equal(attributes['wiki_agent.rag.match_count'], 1);
    assert.equal(attributes['wiki_agent.rag.latency_ms'], 13);
    assert.match(String(attributes['wiki_agent.rag.index_identity']), /chunk-sha/);
});
