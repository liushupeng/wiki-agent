import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { embedText } from '../../rag/embeddings.js';
import { IndexedChunk } from '../../rag/types.js';
import { JsonVectorStore, loadKnowledgeIndex } from '../../rag/vectorStore.js';

function createChunk(input: { id: string; source: string; text: string; titlePath?: string[]; tags?: string[] }): IndexedChunk {
    return {
        id: input.id,
        source: input.source,
        text: input.text,
        start: 0,
        end: input.text.length,
        titlePath: input.titlePath,
        tags: input.tags,
        vector: embedText(input.text)
    };
}

test('JsonVectorStore saves chunks and searches by query similarity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-vector-store-'));
    const indexPath = path.join(dir, 'index.json');
    const store = new JsonVectorStore(indexPath);

    await store.upsertChunks([
        createChunk({ id: 'a#1', source: 'a.md', text: 'agent rag retrieval' }),
        createChunk({ id: 'b#1', source: 'b.md', text: 'cooking recipe' })
    ], { chunkSize: 100, overlap: 10 });

    const matches = await store.search('rag retrieval', 1);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].source, 'a.md');
    assert.equal(matches[0].score > 0, true);

    const index = await loadKnowledgeIndex(indexPath);
    assert.equal(index.chunks.length, 2);
    assert.equal(index.chunkSize, 100);
});

test('JsonVectorStore finds chunks by source and related notes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-vector-store-'));
    const indexPath = path.join(dir, 'index.json');
    const store = new JsonVectorStore(indexPath);

    await store.upsertChunks([
        createChunk({ id: 'a#1', source: 'a.md', text: 'agent memory planning', titlePath: ['Agent'], tags: ['rag'] }),
        createChunk({ id: 'b#1', source: 'b.md', text: 'memory planning trace' }),
        createChunk({ id: 'c#1', source: 'c.md', text: 'unrelated cooking' })
    ], { chunkSize: 100, overlap: 10 });

    const chunks = await store.findBySource('a.md');
    const related = await store.findRelated('a.md', 1);

    assert.equal(chunks.length, 1);
    assert.equal(related.length, 1);
    assert.equal(related[0].source, 'b.md');
});
