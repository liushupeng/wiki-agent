import assert from 'node:assert/strict';
import test from 'node:test';
import { getIndexPaths, parseRagIndexesConfig, resolveRagIndexProfile } from '../../rag/indexProfiles.js';

test('RAG index profiles use isolated profile directories', () => {
    const config = parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'tf-v1',
        activeVariant: 'raw-wiki',
        profiles: [
            { id: 'tf-v1', store: 'json', chunkSize: 900, overlap: 120, embedder: { type: 'tf' }, variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/raw-wiki.jsonc' }] },
            {
                id: 'qwen3-embedding-v1',
                store: 'json',
                chunkSize: 900,
                overlap: 120,
                embedder: {
                    type: 'openai-compatible',
                    baseUrlEnv: 'RAG_EMBEDDING_BASE_URL',
                    apiKeyEnv: 'RAG_EMBEDDING_API_KEY',
                    model: 'qwen3-embedding',
                    dimensions: 1024
                },
                variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/raw-wiki.jsonc' }]
            }
        ]
    });

    const tf = resolveRagIndexProfile(config);
    const qwen = resolveRagIndexProfile(config, 'qwen3-embedding-v1');
    assert.equal(getIndexPaths(tf, tf.variants[0]!, config.indexDirectory).dataPath.endsWith('tf-v1\\raw-wiki\\index.json'), true);
    assert.equal(getIndexPaths(qwen, qwen.variants[0]!, config.indexDirectory).dataPath.endsWith('qwen3-embedding-v1\\raw-wiki\\index.json'), true);
});

test('RAG index profile requires its active profile to exist', () => {
    assert.throws(() => parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'missing',
        activeVariant: 'raw-wiki',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 900, overlap: 120, embedder: { type: 'tf' }, variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/raw-wiki.jsonc' }] }]
    }), /active RAG index profile does not exist/);
});

test('RAG index config requires the active variant in its active profile', () => {
    assert.throws(() => parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'tf-v1',
        activeVariant: 'raw-only',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 900, overlap: 120, embedder: { type: 'tf' }, variants: [{ id: 'raw-wiki', sourceConfigPath: 'config/raw-wiki.jsonc' }] }]
    }), /active RAG index variant does not exist/);
});

test('RAG index profiles support local Transformers.js embeddings in LanceDB', () => {
    const config = parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'bge-m3-v1',
        activeVariant: 'raw-only',
        profiles: [{
            id: 'bge-m3-v1',
            store: 'lancedb',
            chunkSize: 900,
            overlap: 120,
            embedder: {
                type: 'transformers-js',
                model: 'Xenova/bge-m3',
                dimensions: 1024,
                dtype: 'q4',
                device: 'cpu',
                pooling: 'cls',
                maxLength: 512,
                batchSize: 8
            },
            variants: [{ id: 'raw-only', sourceConfigPath: 'config/raw-only.jsonc' }]
        }]
    });

    const profile = resolveRagIndexProfile(config);
    assert.equal(profile.store, 'lancedb');
    assert.equal(profile.embedder.type, 'transformers-js');
    assert.match(getIndexPaths(profile, profile.variants[0]!, config.indexDirectory).dataPath, /index\.lance$/);
});
