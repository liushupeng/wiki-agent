import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TfEmbedder, embedText } from '../../rag/embeddings.js';
import { getIndexPaths, parseRagIndexesConfig, resolveRagIndexProfile } from '../../rag/indexProfiles.js';
import { writeIndexManifest } from '../../rag/indexRuntime.js';
import type { RetrievalRuntime } from '../../rag/retrievalRuntime.js';
import { IndexedChunk } from '../../rag/types.js';
import { JsonVectorStore } from '../../rag/vectorStore.js';
import { GrepNotesTool, ReadNoteTool, RelatedNotesTool, SearchNotesTool } from '../../tools/ragTool.js';

async function withKnowledgeIndex<T>(chunks: IndexedChunk[], run: (indexPath: string) => Promise<T>): Promise<T> {
    const previousConfigPath = process.env.RAG_INDEXES_CONFIG_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-rag-tool-'));
    const configPath = path.join(dir, 'rag.indexes.jsonc');
    const config = {
        indexDirectory: dir,
        activeProfile: 'tf-v1',
        activeVariant: 'raw-wiki',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 100, overlap: 10, embedder: { type: 'tf' }, variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/knowledge.sources.jsonc' }] }]
    };
    await fs.writeFile(configPath, JSON.stringify(config), 'utf-8');
    process.env.RAG_INDEXES_CONFIG_PATH = configPath;
    const profile = resolveRagIndexProfile(parseRagIndexesConfig(config));
    const variant = profile.variants[0]!;
    const paths = getIndexPaths(profile, variant, config.indexDirectory);
    await new JsonVectorStore(paths.dataPath).replaceChunks(toAsyncChunks(chunks), { chunkSize: 100, overlap: 10 });
    await writeIndexManifest(profile, variant, paths, new TfEmbedder().identity);

    try {
        return await run(paths.dataPath);
    } finally {
        if (previousConfigPath === undefined) {
            delete process.env.RAG_INDEXES_CONFIG_PATH;
        } else {
            process.env.RAG_INDEXES_CONFIG_PATH = previousConfigPath;
        }
    }
}

async function* toAsyncChunks(chunks: IndexedChunk[]): AsyncGenerator<IndexedChunk> {
    yield* chunks;
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
    const previousValues = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previousValues.set(key, process.env[key]);
        process.env[key] = value;
    }

    try {
        return await run();
    } finally {
        for (const [key, value] of previousValues) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function writeKnowledgeSourcesConfig(entries: unknown[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-knowledge-sources-'));
    const configPath = path.join(dir, 'knowledge.sources.jsonc');
    await fs.writeFile(configPath, JSON.stringify({ sources: entries }), 'utf-8');
    return configPath;
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

test('SearchNotesTool escalates to its fallback profile only when the primary returns no evidence', async () => {
    const calls: string[] = [];
    const retrievalRuntime: RetrievalRuntime = {
        async retrieve(request) {
            calls.push(request.retrievalProfile!);
            const evidence = request.retrievalProfile === 'deep-v1'
                ? [{
                    id: 'source.md#1',
                    source: 'source.md',
                    text: 'grounded answer',
                    start: 0,
                    end: 15,
                    vector: [],
                    chunkIds: ['source.md#1'],
                    anchorId: 'source.md#1',
                    fusionScore: 1
                }]
                : [];
            return {
                profile: {
                    id: request.retrievalProfile!,
                    mode: 'single',
                    indexProfile: 'bm25-v1',
                    candidateLimit: 20
                },
                run: {
                    profile: request.retrievalProfile!,
                    query: request.query,
                    sparseCandidates: [],
                    denseCandidates: [],
                    fusedCandidates: [],
                    rerankedCandidates: [],
                    sourceLocalCandidates: [],
                    anchorCandidates: [],
                    assembledEvidences: evidence,
                    rerankedEvidences: evidence,
                    evidences: evidence,
                    elapsedMs: {
                        sparse: 0, dense: 0, candidateCache: 0, fusion: 0, chunkRerank: 0,
                        sourceLocal: 0, evidenceAssembly: 0, evidenceRerank: 0, total: 0
                    },
                    diagnostics: {
                        candidateCounts: {
                            sparse: 0, dense: 0, fusion: 0, chunkRerank: 0,
                            sourceLocalRerankDocuments: 0, sourceLocal: 0, anchors: 0,
                            evidenceAssembly: evidence.length, evidenceRerank: 0, final: evidence.length
                        },
                        cache: {
                            candidates: { requests: 0, hits: 0, misses: 0 },
                            reranker: { requests: 0, hits: 0, misses: 0 }
                        }
                    }
                },
                metrics: { retrieverCacheHit: false, retrieverOpenMs: 0, queueWaitMs: 0 }
            };
        }
    };

    const result = await new SearchNotesTool({
        retrievalProfile: 'balanced-v1',
        fallbackRetrievalProfile: 'deep-v1',
        retrievalRuntime
    }).execute({ query: 'answer', topK: 1 });

    assert.equal(result.status, 'success');
    assert.deepEqual(calls, ['balanced-v1', 'deep-v1']);
    assert.equal(result.metadata?.fallbackUsed, true);
    assert.equal(result.metadata?.retrievalProfile, 'deep-v1');
});

test('GrepNotesTool validates arguments', () => {
    const tool = new GrepNotesTool();

    assert.deepEqual(tool.validateArgs({}), ['query must be a non-empty string']);
    assert.deepEqual(tool.validateArgs({ query: 'agent', regex: 'yes' }), ['regex must be a boolean']);
    assert.deepEqual(tool.validateArgs({ query: 'agent', maxResults: 0 }), ['maxResults must be a positive number']);
});

test('GrepNotesTool returns keyword matches from configured knowledge sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-tool-'));
    await fs.writeFile(path.join(dir, 'agent.md'), 'agent = loop + memory + tool\n');
    const configPath = await writeKnowledgeSourcesConfig([
        { name: 'raw', root: dir, kind: 'raw', enabled: true, index: true }
    ]);

    await withEnv({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }, async () => {
        const result = await new GrepNotesTool().execute({ query: 'memory', maxResults: 5 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);
        const data = result.data as { matches: Array<{ source: string; line: number; text: string }> };
        assert.equal(data.matches[0].source, 'raw/agent.md');
        assert.equal(data.matches[0].line, 1);
        assert.match(data.matches[0].text, /memory/);
    });
});

test('GrepNotesTool returns prefixed matches from configured knowledge roots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-roots-'));
    const wikiDir = path.join(dir, 'wiki');
    const rawDir = path.join(dir, 'raw');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(wikiDir, 'agent.md'), 'agent wiki memory\n', 'utf-8');
    await fs.writeFile(path.join(rawDir, 'source.md'), 'agent raw memory\n', 'utf-8');

    const configPath = await writeKnowledgeSourcesConfig([
        { name: 'wiki', root: wikiDir, kind: 'wiki', enabled: true, index: true, priority: 100 },
        { name: 'raw', root: rawDir, kind: 'raw', enabled: true, index: true, priority: 50 }
    ]);

    await withEnv({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }, async () => {
        const result = await new GrepNotesTool().execute({ query: 'memory', maxResults: 5 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 2);
        const data = result.data as { matches: Array<{ source: string }> };
        assert.deepEqual(data.matches.map(match => match.source).sort(), ['raw/source.md', 'wiki/agent.md']);
    });
});

test('GrepNotesTool applies ignore patterns from knowledge source config', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-ignore-'));
    await fs.mkdir(path.join(dir, '__pycache__'), { recursive: true });
    await fs.writeFile(path.join(dir, 'keep.md'), 'agent memory keep\n', 'utf-8');
    await fs.writeFile(path.join(dir, '__pycache__', 'ignored.md'), 'agent memory ignored\n', 'utf-8');
    const configPath = await writeKnowledgeSourcesConfig([
        { name: 'raw', root: dir, kind: 'raw', enabled: true, index: true, ignore: ['**/__pycache__/**'] }
    ]);

    await withEnv({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }, async () => {
        const result = await new GrepNotesTool().execute({ query: 'memory', maxResults: 5 });

        assert.equal(result.status, 'success');
        const data = result.data as { matches: Array<{ source: string }> };
        assert.deepEqual(data.matches.map(match => match.source), ['raw/keep.md']);
    });
});

test('GrepNotesTool caps large result and context requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-budget-'));
    await fs.writeFile(
        path.join(dir, 'many.md'),
        Array.from({ length: 40 }, (_, index) => `memory line ${index + 1}`).join('\n'),
        'utf-8'
    );
    const configPath = await writeKnowledgeSourcesConfig([
        { name: 'raw', root: dir, kind: 'raw', enabled: true, index: true }
    ]);

    await withEnv({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }, async () => {
        const result = await new GrepNotesTool().execute({ query: 'memory', maxResults: 100, contextLines: 10 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 30);
        assert.equal(result.metadata?.maxResults, 30);
        assert.equal(result.metadata?.contextLines, 2);
        const data = result.data as { matches: Array<{ before: string[]; after: string[] }> };
        assert.ok(data.matches.every(match => match.before.length <= 2));
        assert.ok(data.matches.every(match => match.after.length <= 2));
    });
});

test('GrepNotesTool auto-detects regex queries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-auto-regex-'));
    await fs.writeFile(path.join(dir, 'invest.md'), '选股原则\n投资本质\n交易纪律\n', 'utf-8');
    const configPath = await writeKnowledgeSourcesConfig([
        { name: 'raw', root: dir, kind: 'raw', enabled: true, index: true }
    ]);

    await withEnv({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }, async () => {
        const result = await new GrepNotesTool().execute({ query: '选股|投资本质', maxResults: 10, contextLines: 0 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.autoRegex, true);
        const data = result.data as { regex: boolean; matches: Array<{ text: string }> };
        assert.equal(data.regex, true);
        assert.deepEqual(data.matches.map(match => match.text), ['选股原则', '投资本质']);
    });
});

test('SearchNotesTool returns formatted search matches', async () => {
    await withKnowledgeIndex(TEST_CHUNKS, async () => {
        const result = await new SearchNotesTool().execute({ query: 'agent retrieval', topK: 1 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);
        assert.equal(result.metadata?.indexProfile, 'tf-v1');

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

test('SearchNotesTool prioritizes maintained wiki matches over raw source matches', async () => {
    const chunks = [
        createChunk({
            id: 'raw/agent.md#1',
            source: 'raw/agent.md',
            text: 'agent retrieval planning raw source'
        }),
        createChunk({
            id: 'wiki/agent.md#1',
            source: 'wiki/agent.md',
            text: 'agent retrieval planning maintained wiki'
        })
    ];

    await withKnowledgeIndex(chunks, async () => {
        const result = await new SearchNotesTool().execute({ query: 'agent retrieval planning', topK: 1 });

        assert.equal(result.status, 'success');
        const data = result.data as { matches: Array<Record<string, unknown>> };
        assert.equal(data.matches[0].source, 'wiki/agent.md');
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

test('ReadNoteTool caps default reads and can filter by query', async () => {
    const chunks = Array.from({ length: 12 }, (_, index) => createChunk({
        id: `large.md#${index + 1}`,
        source: 'large.md',
        text: index === 9 ? 'investment system evidence' : `general note ${index + 1}`,
        titlePath: [index === 9 ? 'Investment' : 'General']
    }));

    await withKnowledgeIndex(chunks, async () => {
        const defaultResult = await new ReadNoteTool().execute({ notePath: 'large.md' });

        assert.equal(defaultResult.status, 'success');
        assert.equal(defaultResult.metadata?.count, 8);
        assert.equal(defaultResult.metadata?.totalChunks, 12);
        assert.equal(defaultResult.metadata?.truncated, true);

        const filteredResult = await new ReadNoteTool().execute({ notePath: 'large.md', query: 'investment', maxChunks: 3 });
        assert.equal(filteredResult.status, 'success');
        assert.equal(filteredResult.metadata?.count, 1);
        assert.equal(filteredResult.metadata?.matchedChunks, 1);
        assert.equal(filteredResult.metadata?.truncated, false);
        const data = filteredResult.data as { chunks: Array<{ text: string }> };
        assert.equal(data.chunks[0].text, 'investment system evidence');
    });
});

test('ReadNoteTool filters by title path', async () => {
    await withKnowledgeIndex([
        createChunk({ id: 'invest.md#1', source: 'invest.md', text: 'overview', titlePath: ['1 Overview'] }),
        createChunk({ id: 'invest.md#2', source: 'invest.md', text: 'eight rules', titlePath: ['15 投资体系', '八项原则'] })
    ], async () => {
        const result = await new ReadNoteTool().execute({ notePath: 'invest.md', titlePath: '投资体系' });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.count, 1);
        const data = result.data as { chunks: Array<{ text: string; titlePath: string[] }> };
        assert.equal(data.chunks[0].text, 'eight rules');
        assert.deepEqual(data.chunks[0].titlePath, ['15 投资体系', '八项原则']);
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

test('RelatedNotesTool defaults to same-directory matches', async () => {
    await withKnowledgeIndex([
        createChunk({ id: 'raw/invest/main.md#1', source: 'raw/invest/main.md', text: 'cycle value compound strategy' }),
        createChunk({ id: 'raw/invest/peer.md#1', source: 'raw/invest/peer.md', text: 'cycle value compound strategy evidence' }),
        createChunk({ id: 'raw/programming/cpp.md#1', source: 'raw/programming/cpp.md', text: 'cycle value compound strategy unrelated code' })
    ], async () => {
        const result = await new RelatedNotesTool().execute({ notePath: 'raw/invest/main.md', topK: 5 });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.scope, 'sameDirectory');
        const data = result.data as { matches: Array<{ source: string }> };
        assert.deepEqual(data.matches.map(match => match.source), ['raw/invest/peer.md']);
    });
});

test('RelatedNotesTool widens global recall before applying a local scope', async () => {
    const distractors = Array.from({ length: 120 }, (_, index) => createChunk({
        id: `raw/other/${String(index).padStart(3, '0')}.md#1`,
        source: `raw/other/${String(index).padStart(3, '0')}.md`,
        text: 'shared semantic vector'
    }));
    await withKnowledgeIndex([
        createChunk({ id: 'raw/topic/source.md#1', source: 'raw/topic/source.md', text: 'shared semantic vector' }),
        ...distractors,
        createChunk({ id: 'raw/topic/z-related.md#1', source: 'raw/topic/z-related.md', text: 'shared semantic vector' })
    ], async () => {
        const result = await new RelatedNotesTool().execute({
            notePath: 'raw/topic/source.md',
            topK: 1
        });

        assert.equal(result.status, 'success');
        const data = result.data as { matches: Array<{ source: string }> };
        assert.deepEqual(data.matches.map(match => match.source), ['raw/topic/z-related.md']);
        assert.ok(Number(result.metadata?.candidateCount) > 100);
    });
});

test('RelatedNotesTool can expand to source-root scope', async () => {
    await withKnowledgeIndex([
        createChunk({ id: 'raw/invest/main.md#1', source: 'raw/invest/main.md', text: 'cycle value compound strategy' }),
        createChunk({ id: 'raw/other/peer.md#1', source: 'raw/other/peer.md', text: 'cycle value compound strategy evidence' }),
        createChunk({ id: 'wiki/invest.md#1', source: 'wiki/invest.md', text: 'cycle value compound strategy wiki' })
    ], async () => {
        const result = await new RelatedNotesTool().execute({ notePath: 'raw/invest/main.md', topK: 5, scope: 'sourceRoot' });

        assert.equal(result.status, 'success');
        const data = result.data as { matches: Array<{ source: string }> };
        assert.deepEqual(data.matches.map(match => match.source), ['raw/other/peer.md']);
    });
});

test('SearchNotesTool returns a helpful error when the index is missing', async () => {
    const previousConfigPath = process.env.RAG_INDEXES_CONFIG_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-rag-tool-missing-'));
    const configPath = path.join(dir, 'rag.indexes.jsonc');
    await fs.writeFile(configPath, JSON.stringify({
        indexDirectory: dir,
        activeProfile: 'tf-v1',
        activeVariant: 'raw-wiki',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 100, overlap: 10, embedder: { type: 'tf' }, variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/knowledge.sources.jsonc' }] }]
    }), 'utf-8');
    process.env.RAG_INDEXES_CONFIG_PATH = configPath;

    try {
        const result = await new SearchNotesTool().execute({ query: 'agent' });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /cannot open RAG index manifest|ENOENT/i);
        assert.match(String(result.metadata?.hint), /npm run index:knowledge/);
    } finally {
        if (previousConfigPath === undefined) {
            delete process.env.RAG_INDEXES_CONFIG_PATH;
        } else {
            process.env.RAG_INDEXES_CONFIG_PATH = previousConfigPath;
        }
    }
});
