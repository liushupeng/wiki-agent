import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Reranker } from '../../rag/reranker.js';
import { CachedReranker } from '../../rag/rerankerCache.js';

test('CachedReranker reuses scores and deduplicates repeated pairs', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-reranker-cache-'));
    let scoredDocuments = 0;
    const inner: Reranker = {
        name: 'fake-reranker',
        async score(_query, documents) {
            scoredDocuments += documents.length;
            return documents.map(document => document.length / 10);
        }
    };
    const profile = {
        model: 'fake-reranker',
        dtype: 'q4',
        device: 'cpu' as const,
        maxLength: 512,
        batchSize: 8
    };

    try {
        const firstCache = new CachedReranker(inner, profile, directory);
        const first = await firstCache.score('query', ['same', 'same', 'different']);
        const secondCache = new CachedReranker(inner, profile, directory);
        const second = await secondCache.score('query', ['same', 'different']);

        assert.deepEqual(first, [0.4, 0.4, 0.9]);
        assert.deepEqual(second, [0.4, 0.9]);
        assert.equal(scoredDocuments, 2);
        assert.deepEqual(firstCache.getCacheStats(), { requests: 3, hits: 0, misses: 3 });
        assert.deepEqual(secondCache.getCacheStats(), { requests: 2, hits: 2, misses: 0 });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('CachedReranker isolates scores by query and model identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-reranker-cache-'));
    let scoredDocuments = 0;
    const inner: Reranker = {
        name: 'fake-reranker',
        async score(query, documents) {
            scoredDocuments += documents.length;
            return documents.map(document => query.length + document.length);
        }
    };

    try {
        const profile = { model: 'model-a', maxLength: 512, batchSize: 8 };
        await new CachedReranker(inner, profile, directory).score('a', ['document']);
        await new CachedReranker(inner, profile, directory).score('bb', ['document']);
        await new CachedReranker(inner, { ...profile, model: 'model-b' }, directory).score('a', ['document']);
        assert.equal(scoredDocuments, 3);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
