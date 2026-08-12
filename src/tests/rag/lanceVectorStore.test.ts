import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LanceDbVectorStore } from '../../rag/vectorStore.js';

test('LanceDB stores dense chunks and performs exact cosine search', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-lance-'));
    const store = new LanceDbVectorStore(directory);
    try {
        await store.replaceChunks(chunks(), { chunkSize: 100, overlap: 10 });
        const matches = await store.search([1, 0], 2);
        assert.equal(matches[0]?.id, 'a#1');
        assert.equal(matches[1]?.id, 'b#1');
        assert.deepEqual((await store.findBySource('a.md')).map(item => item.id), ['a#1']);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

async function* chunks() {
    yield { id: 'a#1', source: 'a.md', text: 'a', start: 0, end: 1, vector: [1, 0] };
    yield { id: 'b#1', source: 'b.md', text: 'b', start: 0, end: 1, vector: [0, 1] };
}
