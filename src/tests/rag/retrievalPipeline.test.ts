import assert from 'node:assert/strict';
import test from 'node:test';
import { limitPerSource, reciprocalRankFusion } from '../../rag/retrievalPipeline.js';
import { SearchResult } from '../../rag/types.js';

function result(id: string, source: string, score: number): SearchResult {
    return { id, source, score, text: id, start: 0, end: id.length, vector: {} };
}

test('RRF fuses sparse and dense ranks by stable chunk id', () => {
    const sparse = [
        result('a#1', 'a.md', 10),
        result('b#1', 'b.md', 9)
    ];
    const dense = [
        result('b#1', 'b.md', 0.9),
        result('c#1', 'c.md', 0.8)
    ];

    const fused = reciprocalRankFusion(sparse, dense, 60, 10);

    assert.deepEqual(fused.map(item => item.id), ['b#1', 'a#1', 'c#1']);
    assert.equal(fused[0]?.sparseRank, 2);
    assert.equal(fused[0]?.denseRank, 1);
    assert.equal(fused[0]?.fusionScore, 1 / 62 + 1 / 61);
});

test('per-source limit uses normalized complete document paths and backfills', () => {
    const selected = limitPerSource([
        { source: 'raw\\a.md', id: 'a1' },
        { source: 'raw/a.md', id: 'a2' },
        { source: 'raw/b.md', id: 'b1' },
        { source: 'raw/c.md', id: 'c1' }
    ], 1, 3);

    assert.deepEqual(selected.map(item => item.id), ['a1', 'b1', 'c1']);
});
