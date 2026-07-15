import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { embedText } from '../../rag/embeddings.js';
import { IndexedChunk } from '../../rag/types.js';
import { JsonVectorStore } from '../../rag/vectorStore.js';
import { GrepNotesTool, ReadNoteTool, RelatedNotesTool, SearchNotesTool } from '../../tools/ragTool.js';

async function withKnowledgeIndex<T>(chunks: IndexedChunk[], run: (indexPath: string) => Promise<T>): Promise<T> {
    const previousIndexPath = process.env.KNOWLEDGE_INDEX_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-rag-tool-'));
    const indexPath = path.join(dir, 'index.json');
    process.env.KNOWLEDGE_INDEX_PATH = indexPath;
    await new JsonVectorStore(indexPath).upsertChunks(chunks, { chunkSize: 100, overlap: 10 });

    try {
        return await run(indexPath);
    } finally {
        if (previousIndexPath === undefined) {
            delete process.env.KNOWLEDGE_INDEX_PATH;
        } else {
            process.env.KNOWLEDGE_INDEX_PATH = previousIndexPath;
        }
    }
}

function createChunk(input: {
    id: string;
    source: string;
    text: string;
    titlePath?: string[];
    tags?: string[];
    links?: string[];
}): IndexedChunk {
    return {
        id: input.id,
        source: input.source,
        text: input.text,
        start: 0,
        end: input.text.length,
        titlePath: input.titlePath,
        tags: input.tags,
        links: input.links,
        vector: embedText(input.text)
    };
}

const TEST_CHUNKS = [
    createChunk({
        id: 'agent.md#1',
        source: 'agent.md',
        text: 'agent memory planning retrieval',
        titlePath: ['Agent', 'Memory'],
        tags: ['rag'],
        links: ['memory.md']
    }),
    createChunk({
        id: 'memory.md#1',
        source: 'memory.md',
        text: 'memory planning trace summary',
        titlePath: ['Memory'],
        tags: ['agent']
    }),
    createChunk({
        id: 'cooking.md#1',
        source: 'cooking.md',
        text: 'cooking recipe'
    })
];

test('SearchNotesTool validates arguments', () => {
    const tool = new SearchNotesTool();

    assert.deepEqual(tool.validateArgs({}), ['query must be a non-empty string']);
    assert.deepEqual(tool.validateArgs({ query: 'agent', topK: 0 }), ['topK must be a positive number']);
});

test('GrepNotesTool validates arguments', () => {
    const tool = new GrepNotesTool();

    assert.deepEqual(tool.validateArgs({}), ['query must be a non-empty string']);
    assert.deepEqual(tool.validateArgs({ query: 'agent', regex: 'yes' }), ['regex must be a boolean']);
    assert.deepEqual(tool.validateArgs({ query: 'agent', maxResults: 0 }), ['maxResults must be a positive number']);
});

test('GrepNotesTool returns keyword matches from NOTES_ROOT', async () => {
    const previousNotesRoot = process.env.NOTES_ROOT;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-tool-'));
    process.env.NOTES_ROOT = dir;
    await fs.writeFile(path.join(dir, 'agent.md'), 'agent = loop + memory + tool\n');

    try {
        const result = await new GrepNotesTool().execute({ query: 'memory', maxResults: 5 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);
        const data = result.data as { matches: Array<{ source: string; line: number; text: string }> };
        assert.equal(data.matches[0].source, 'agent.md');
        assert.equal(data.matches[0].line, 1);
        assert.match(data.matches[0].text, /memory/);
    } finally {
        if (previousNotesRoot === undefined) {
            delete process.env.NOTES_ROOT;
        } else {
            process.env.NOTES_ROOT = previousNotesRoot;
        }
    }
});

test('SearchNotesTool returns formatted search matches', async () => {
    await withKnowledgeIndex(TEST_CHUNKS, async indexPath => {
        const result = await new SearchNotesTool().execute({ query: 'agent retrieval', topK: 1 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);
        assert.equal(result.metadata?.indexPath, path.resolve(indexPath));

        const data = result.data as { query: string; matches: Array<Record<string, unknown>> };
        assert.equal(data.query, 'agent retrieval');
        assert.equal(data.matches[0].source, 'agent.md');
        assert.equal(data.matches[0].chunkId, 'agent.md#1');
        assert.deepEqual(data.matches[0].titlePath, ['Agent', 'Memory']);
        assert.deepEqual(data.matches[0].tags, ['rag']);
        assert.deepEqual(data.matches[0].links, ['memory.md']);
        assert.equal(typeof data.matches[0].score, 'number');
        assert.equal(data.matches[0].citation, 'agent.md > Agent > Memory');
        assert.deepEqual(data.matches[0].span, { start: 0, end: 'agent memory planning retrieval'.length });
    });
});

test('ReadNoteTool returns chunks by note path', async () => {
    await withKnowledgeIndex(TEST_CHUNKS, async () => {
        const result = await new ReadNoteTool().execute({ notePath: 'agent.md' });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);

        const data = result.data as { notePath: string; chunks: Array<Record<string, unknown>> };
        assert.equal(data.notePath, 'agent.md');
        assert.equal(data.chunks[0].source, 'agent.md');
        assert.equal(data.chunks[0].chunkId, 'agent.md#1');
        assert.deepEqual(data.chunks[0].titlePath, ['Agent', 'Memory']);
    });
});

test('RelatedNotesTool returns related chunks excluding the source note', async () => {
    await withKnowledgeIndex(TEST_CHUNKS, async () => {
        const result = await new RelatedNotesTool().execute({ notePath: 'agent.md', topK: 1 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);

        const data = result.data as { notePath: string; matches: Array<Record<string, unknown>> };
        assert.equal(data.notePath, 'agent.md');
        assert.equal(data.matches[0].source, 'memory.md');
    });
});

test('SearchNotesTool returns a helpful error when the index is missing', async () => {
    const previousIndexPath = process.env.KNOWLEDGE_INDEX_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-rag-tool-missing-'));
    process.env.KNOWLEDGE_INDEX_PATH = path.join(dir, 'missing.json');

    try {
        const result = await new SearchNotesTool().execute({ query: 'agent' });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /no such file|cannot find/i);
        assert.match(String(result.metadata?.hint), /npm run index:notes/);
    } finally {
        if (previousIndexPath === undefined) {
            delete process.env.KNOWLEDGE_INDEX_PATH;
        } else {
            process.env.KNOWLEDGE_INDEX_PATH = previousIndexPath;
        }
    }
});
