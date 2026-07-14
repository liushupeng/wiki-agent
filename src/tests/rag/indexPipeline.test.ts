import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runIndexPipeline } from '../../rag/indexPipeline.js';
import { SourceDocument } from '../../rag/types.js';
import { JsonVectorStore, loadKnowledgeIndex } from '../../rag/vectorStore.js';

test('runIndexPipeline chunks documents, embeds chunks, and writes them to the vector store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-index-pipeline-'));
    const indexPath = path.join(dir, 'index.json');
    const documents: SourceDocument[] = [{
        source: 'note.md',
        absolutePath: path.join(dir, 'note.md'),
        extension: '.md',
        content: [
            '---',
            'tags: [agent, rag]',
            '---',
            '# Agent Notes',
            'Agentic RAG uses planning and retrieval.'
        ].join('\n')
    }];

    const stats = await runIndexPipeline({
        sourceDir: dir,
        documents,
        chunkSize: 200,
        overlap: 20,
        vectorStore: new JsonVectorStore(indexPath)
    });

    const index = await loadKnowledgeIndex(indexPath);

    assert.equal(stats.documentCount, 1);
    assert.equal(stats.chunkCount, 1);
    assert.equal(stats.embedder, 'tf');
    assert.equal(stats.store, 'json');
    assert.equal(index.chunks.length, 1);
    assert.deepEqual(index.chunks[0].titlePath, ['Agent Notes']);
    assert.deepEqual(index.chunks[0].tags, ['agent', 'rag']);
    assert.equal(Object.keys(index.chunks[0].vector).length > 0, true);
});
