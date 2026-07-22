import assert from 'node:assert/strict';
import test from 'node:test';
import { Bm25Embedder, createEmbedder, embedText, TfEmbedder, tokenize, tokenizeForBm25 } from '../../rag/embeddings.js';

test('tokenize lowercases text and keeps letter and number tokens', () => {
    assert.deepEqual(tokenize('Agent RAG v2, A!'), ['agent', 'rag', 'v2']);
});

test('embedText returns normalized term-frequency vectors', () => {
    const vector = embedText('agent agent rag');

    assert.equal(Array.isArray(vector), false);
    if (Array.isArray(vector)) throw new Error('expected sparse vector');
    assert.equal(Number(vector.agent.toFixed(4)), 0.8944);
    assert.equal(Number(vector.rag.toFixed(4)), 0.4472);
});

test('TfEmbedder embeds single texts and batches', () => {
    const embedder = new TfEmbedder();

    assert.equal(embedder.name, 'tf');
    assert.deepEqual(embedder.embedBatch(['agent', 'rag']).map(vector => ({ ...vector })), [
        { agent: 1 },
        { rag: 1 }
    ]);
});

test('createEmbedder creates a configured profile', () => {
    assert.equal(createEmbedder({ type: 'tf' }).name, 'tf');
});

test('Bm25Embedder keeps raw term frequencies', () => {
    const embedder = new Bm25Embedder({ type: 'bm25', k1: 1.2, b: 0.75 });
    assert.deepEqual({ ...embedder.embed('agent agent rag') }, { agent: 2, rag: 1 });
    assert.equal(embedder.identity.normalization, 'none');
});

test('tokenizeForBm25 splits Chinese text into overlapping bigrams', () => {
    assert.deepEqual(tokenizeForBm25('知识库检索 RAG v2'), ['知识', '识库', '库检', '检索', 'rag', 'v2']);
});
