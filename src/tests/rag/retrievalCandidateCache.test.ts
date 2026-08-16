import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RetrievalCandidateCache } from '../../rag/retrievalCandidateCache.js';
import { SearchResult } from '../../rag/types.js';

function result(id: string, vector: SearchResult['vector']): SearchResult {
    return { id, source: `${id}.md`, text: id, start: 0, end: id.length, score: 1, vector };
}

test('RetrievalCandidateCache freezes candidates by index, query, and limit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-candidate-cache-'));
    let loads = 0;
    const load = async () => {
        loads += 1;
        return {
            sparse: [result('sparse', { token: 1 })],
            dense: [result('dense', [0.1, 0.2])]
        };
    };

    try {
        const firstCache = new RetrievalCandidateCache(directory, 'snapshot-a');
        const first = await firstCache.getOrLoad('query', 100, load);
        const second = await new RetrievalCandidateCache(directory, 'snapshot-a')
            .getOrLoad('query', 100, load);
        await firstCache.getOrLoad('query', 20, load);
        await new RetrievalCandidateCache(directory, 'snapshot-b').getOrLoad('query', 100, load);

        assert.equal(loads, 3);
        assert.deepEqual(first.sparse[0]?.vector, []);
        assert.deepEqual(first.dense[0]?.vector, []);
        assert.deepEqual(second, first);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
