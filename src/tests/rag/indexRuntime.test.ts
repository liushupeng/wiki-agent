import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bm25Embedder, TfEmbedder, embedText, termFrequencies } from '../../rag/embeddings.js';
import { RagIndexesConfig, getIndexPaths, parseRagIndexesConfig, resolveRagIndexProfile } from '../../rag/indexProfiles.js';
import { openIndexRuntime, writeIndexManifest } from '../../rag/indexRuntime.js';
import { IndexedChunk } from '../../rag/types.js';
import { JsonVectorStore } from '../../rag/vectorStore.js';

async function* chunks(...items: IndexedChunk[]): AsyncGenerator<IndexedChunk> {
    yield* items;
}

function chunk(): IndexedChunk {
    return {
        id: 'agent.md#1',
        source: 'wiki/agent.md',
        text: 'agent memory retrieval',
        start: 0,
        end: 22,
        vector: embedText('agent memory retrieval')
    };
}

function config(): RagIndexesConfig {
    return parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'tf-v1',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 100, overlap: 10, embedder: { type: 'tf' } }]
    });
}

test('index runtime opens a profile-bound manifest and uses its embedder', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-index-runtime-'));
    const profile = resolveRagIndexProfile(config());
    const paths = getIndexPaths(profile, directory);
    await new JsonVectorStore(paths.dataPath).replaceChunks(chunks(chunk()), { chunkSize: 100, overlap: 10 });
    await writeIndexManifest(profile, paths, new TfEmbedder().identity);

    const runtime = await openIndexRuntime(profile, paths);
    const matches = await runtime.search('memory', 1);
    assert.equal(matches[0].source, 'wiki/agent.md');
    assert.equal(runtime.manifest.profileId, 'tf-v1');
});

test('index runtime rejects a manifest built for changed profile settings', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-index-runtime-mismatch-'));
    const profile = resolveRagIndexProfile(config());
    const paths = getIndexPaths(profile, directory);
    await new JsonVectorStore(paths.dataPath).replaceChunks(chunks(chunk()), { chunkSize: 100, overlap: 10 });
    await writeIndexManifest(profile, paths, new TfEmbedder().identity);

    const changed = { ...profile, chunkSize: 120 };
    await assert.rejects(() => openIndexRuntime(changed, paths), /profile changed since this index was built/);
});

test('index runtime applies BM25 scoring for a BM25 profile', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-bm25-runtime-'));
    const profile = resolveRagIndexProfile(parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'bm25-v1',
        profiles: [{ id: 'bm25-v1', store: 'json', chunkSize: 100, overlap: 10, embedder: { type: 'bm25', k1: 1.2, b: 0.75 } }]
    }));
    if (profile.embedder.type !== 'bm25') throw new Error('expected BM25 profile');
    const paths = getIndexPaths(profile, directory);
    const items: IndexedChunk[] = [
        { ...chunk(), vector: termFrequencies('agent memory retrieval') },
        { ...chunk(), id: 'cooking.md#1', source: 'raw/cooking.md', vector: termFrequencies('cooking recipe') }
    ];
    await new JsonVectorStore(paths.dataPath).replaceChunks(chunks(...items), { chunkSize: 100, overlap: 10 });
    await writeIndexManifest(profile, paths, new Bm25Embedder(profile.embedder).identity);

    const matches = await (await openIndexRuntime(profile, paths)).search('memory', 1);
    assert.equal(matches[0].source, 'wiki/agent.md');
});
