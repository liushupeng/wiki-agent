import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TfEmbedder } from '../../rag/embeddings.js';
import { runIndexPipeline } from '../../rag/indexPipeline.js';
import { KnowledgeCatalog, parseKnowledgeCatalog } from '../../rag/knowledgeCatalog.js';
import { SourceDocument } from '../../rag/types.js';
import { JsonVectorStore, loadKnowledgeIndex } from '../../rag/vectorStore.js';

async function* documentStream(...documents: SourceDocument[]): AsyncGenerator<SourceDocument> {
    yield* documents;
}

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
        documents: documentStream(...documents),
        chunkSize: 200,
        overlap: 20,
        embedder: new TfEmbedder(),
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

test('runIndexPipeline consumes documents from an async iterable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-index-pipeline-stream-'));
    const indexPath = path.join(dir, 'index.json');
    const consumed: string[] = [];
    const progress: Array<{ documentCount: number; chunkCount: number; currentSource: string }> = [];

    async function* documents(): AsyncGenerator<SourceDocument> {
        for (const source of ['first.md', 'second.md']) {
            consumed.push(source);
            yield {
                source,
                absolutePath: path.join(dir, source),
                extension: '.md',
                content: `# ${source}\nstreamed content`
            };
        }
    }

    const stats = await runIndexPipeline({
        sourceDir: dir,
        documents: documents(),
        chunkSize: 200,
        overlap: 20,
        embedder: new TfEmbedder(),
        vectorStore: new JsonVectorStore(indexPath),
        onProgress: current => progress.push(current)
    });

    const index = await loadKnowledgeIndex(indexPath);
    assert.deepEqual(consumed, ['first.md', 'second.md']);
    assert.equal(stats.documentCount, 2);
    assert.equal(stats.chunkCount, 2);
    assert.equal(index.chunks.length, 2);
    assert.deepEqual(progress, [
        { documentCount: 1, chunkCount: 1, currentSource: 'first.md' },
        { documentCount: 2, chunkCount: 2, currentSource: 'second.md' }
    ]);
});

test('runIndexPipeline applies catalog hard filters and governance metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-index-governance-'));
    const indexPath = path.join(dir, 'index.json');
    const catalog = new KnowledgeCatalog(parseKnowledgeCatalog({
        version: 1,
        records: [
            { sourceId: 'raw/old.md', versionId: 'doc@1', status: 'superseded', authority: 'low', quality: 0.2, consistencyStatus: 'clear', supersededBy: 'doc@2' },
            { sourceId: 'wiki/current.md', versionId: 'doc@2', status: 'active', authority: 'high', quality: 0.9, consistencyStatus: 'clear' }
        ]
    }));

    const stats = await runIndexPipeline({
        sourceDir: dir,
        documents: documentStream(
            { source: 'raw/old.md', absolutePath: path.join(dir, 'old.md'), extension: '.md', content: '# Old\nobsolete' },
            { source: 'wiki/current.md', absolutePath: path.join(dir, 'current.md'), extension: '.md', content: '# Current\ncurrent' }
        ),
        knowledgeCatalog: catalog,
        chunkSize: 200,
        overlap: 20,
        embedder: new TfEmbedder(),
        vectorStore: new JsonVectorStore(indexPath)
    });
    const index = await loadKnowledgeIndex(indexPath);

    assert.equal(stats.documentCount, 1);
    assert.equal(stats.skippedDocumentCount, 1);
    assert.deepEqual(index.chunks.map(chunk => chunk.source), ['wiki/current.md']);
    assert.equal(index.chunks[0]?.frontmatter?.knowledgeAuthority, 'high');
});
