import assert from 'node:assert/strict';
import test from 'node:test';
import type { RetrievalRun, Retriever } from '../../rag/retrievalPipeline.js';
import { CachedRetrievalRuntime } from '../../rag/retrievalRuntime.js';

test('CachedRetrievalRuntime reuses a retriever for the same profile and variant', async () => {
    let openCount = 0;
    const runtime = new CachedRetrievalRuntime(async () => {
        openCount += 1;
        return fakeRetriever(async query => emptyRun(query));
    }, 1);

    const first = await runtime.retrieve({ retrievalProfile: 'hybrid', variant: 'raw-wiki', query: 'one' });
    const second = await runtime.retrieve({ retrievalProfile: 'hybrid', variant: 'raw-wiki', query: 'two' });

    assert.equal(openCount, 1);
    assert.equal(first.metrics.retrieverCacheHit, false);
    assert.equal(second.metrics.retrieverCacheHit, true);
});

test('CachedRetrievalRuntime serializes CPU-heavy retrieval calls by default', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const blocker = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runtime = new CachedRetrievalRuntime(async () => fakeRetriever(async query => {
        calls.push(query);
        if (query === 'first') {
            firstStarted();
            await blocker;
        }
        return emptyRun(query);
    }), 1);

    const first = runtime.retrieve({ retrievalProfile: 'hybrid', variant: 'raw-wiki', query: 'first' });
    const second = runtime.retrieve({ retrievalProfile: 'hybrid', variant: 'raw-wiki', query: 'second' });
    await started;
    assert.deepEqual(calls, ['first']);
    releaseFirst();
    const [, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(calls, ['first', 'second']);
    assert.ok(secondResult.metrics.queueWaitMs >= 0);
});

test('CachedRetrievalRuntime rejects invalid concurrency', () => {
    assert.throws(() => new CachedRetrievalRuntime(async () => fakeRetriever(async query => emptyRun(query)), 0), /positive integer/);
});

function fakeRetriever(retrieve: (query: string) => Promise<RetrievalRun>): Retriever {
    return {
        profile: {
            id: 'hybrid',
            mode: 'hybrid',
            sparseProfile: 'bm25-v1',
            denseProfile: 'bge-m3-v1',
            candidateLimitPerRetriever: 100,
            fusionLimit: 100,
            rrfK: 60
        },
        retrieve
    };
}

function emptyRun(query: string): RetrievalRun {
    return {
        profile: 'hybrid',
        query,
        sparseCandidates: [],
        denseCandidates: [],
        fusedCandidates: [],
        rerankedCandidates: [],
        sourceLocalCandidates: [],
        anchorCandidates: [],
        assembledEvidences: [],
        rerankedEvidences: [],
        evidences: [],
        elapsedMs: {
            sparse: 0,
            dense: 0,
            candidateCache: 0,
            fusion: 0,
            chunkRerank: 0,
            sourceLocal: 0,
            evidenceAssembly: 0,
            evidenceRerank: 0,
            total: 0
        },
        diagnostics: {
            candidateCounts: {
                sparse: 0,
                dense: 0,
                fusion: 0,
                chunkRerank: 0,
                sourceLocalRerankDocuments: 0,
                sourceLocal: 0,
                anchors: 0,
                evidenceAssembly: 0,
                evidenceRerank: 0,
                final: 0
            },
            cache: {
                candidates: { requests: 0, hits: 0, misses: 0 },
                reranker: { requests: 0, hits: 0, misses: 0 }
            }
        }
    };
}
