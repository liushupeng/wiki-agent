import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbedderFromEnv, embedText, TfEmbedder, tokenize } from '../../rag/embeddings.js';

test('tokenize lowercases text and keeps letter and number tokens', () => {
    assert.deepEqual(tokenize('Agent RAG v2, A!'), ['agent', 'rag', 'v2']);
});

test('embedText returns normalized term-frequency vectors', () => {
    const vector = embedText('agent agent rag');

    assert.equal(Number(vector.agent.toFixed(4)), 0.8944);
    assert.equal(Number(vector.rag.toFixed(4)), 0.4472);
});

test('TfEmbedder embeds single texts and batches', () => {
    const embedder = new TfEmbedder();

    assert.equal(embedder.name, 'tf');
    assert.deepEqual(embedder.embedBatch(['agent', 'rag']), [
        { agent: 1 },
        { rag: 1 }
    ]);
});

test('createEmbedderFromEnv creates supported embedders and rejects unknown names', () => {
    assert.equal(createEmbedderFromEnv('tf').name, 'tf');
    assert.throws(() => createEmbedderFromEnv('unknown'), /unsupported RAG_EMBEDDER/);
});
