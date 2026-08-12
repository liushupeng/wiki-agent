import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CachedEmbedder } from '../../rag/embeddingCache.js';
import { Embedder } from '../../rag/embeddings.js';

test('CachedEmbedder reuses content-addressed dense vectors', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-embedding-cache-'));
    let embeddedTexts = 0;
    const inner: Embedder = {
        name: 'fake-dense',
        identity: { type: 'transformers-js', provider: 'fake', model: 'fake-v1', dimensions: 2, normalization: 'l2' },
        async embed(text: string) {
            embeddedTexts += 1;
            return [text.length, 1];
        },
        async embedBatch(texts: string[]) {
            embeddedTexts += texts.length;
            return texts.map(text => [text.length, 1]);
        }
    };

    try {
        const first = await new CachedEmbedder(inner, directory).embedBatch(['alpha', 'beta']);
        const second = await new CachedEmbedder(inner, directory).embedBatch(['alpha', 'beta']);
        assert.deepEqual(first, [[5, 1], [4, 1]]);
        assert.deepEqual(second, first);
        assert.equal(embeddedTexts, 2);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
