import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findNoteChunks, findRelatedNoteChunks, saveKnowledgeIndex, searchKnowledgeIndex } from '../../rag/localVectorStore.js';

test('localVectorStore compatibility helpers delegate to JsonVectorStore', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-local-store-'));
    const indexPath = path.join(dir, 'index.json');

    await saveKnowledgeIndex(indexPath, {
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        chunkSize: 100,
        overlap: 10,
        chunks: [
            {
                id: 'agent.md#1',
                source: 'agent.md',
                text: 'agent rag retrieval planning',
                start: 0,
                end: 28,
                tags: ['agent'],
                links: ['markdown.md'],
                vector: { agent: 1, rag: 1, retrieval: 1, planning: 1 }
            },
            {
                id: 'markdown.md#1',
                source: 'markdown.md',
                text: 'markdown indexing frontmatter tags',
                start: 0,
                end: 34,
                tags: ['markdown'],
                vector: { markdown: 1, indexing: 1, frontmatter: 1, tags: 1 }
            }
        ]
    });

    const searchResults = await searchKnowledgeIndex(indexPath, 'agent retrieval', 1);
    const noteChunks = await findNoteChunks(indexPath, 'agent.md');
    const related = await findRelatedNoteChunks(indexPath, 'agent.md', 1);

    assert.equal(searchResults[0].source, 'agent.md');
    assert.equal(noteChunks.length, 1);
    assert.equal(noteChunks[0].id, 'agent.md#1');
    assert.equal(related[0].source, 'markdown.md');
});
