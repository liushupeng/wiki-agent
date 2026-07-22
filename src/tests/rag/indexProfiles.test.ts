import assert from 'node:assert/strict';
import test from 'node:test';
import { getIndexPaths, parseRagIndexesConfig, resolveRagIndexProfile } from '../../rag/indexProfiles.js';

test('RAG index profiles use isolated profile directories', () => {
    const config = parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'tf-v1',
        profiles: [
            { id: 'tf-v1', store: 'json', chunkSize: 900, overlap: 120, embedder: { type: 'tf' } },
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
                }
            }
        ]
    });

    assert.equal(getIndexPaths(resolveRagIndexProfile(config), config.indexDirectory).dataPath.endsWith('tf-v1\\index.json'), true);
    assert.equal(getIndexPaths(resolveRagIndexProfile(config, 'qwen3-embedding-v1'), config.indexDirectory).dataPath.endsWith('qwen3-embedding-v1\\index.json'), true);
});

test('RAG index profile requires its active profile to exist', () => {
    assert.throws(() => parseRagIndexesConfig({
        indexDirectory: 'var/indexes',
        activeProfile: 'missing',
        profiles: [{ id: 'tf-v1', store: 'json', chunkSize: 900, overlap: 120, embedder: { type: 'tf' } }]
    }), /active RAG index profile does not exist/);
});
