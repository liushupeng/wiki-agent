import assert from 'node:assert/strict';
import test from 'node:test';
import {
    aggregateSourceCandidates,
    assembleEvidenceWindows,
    formatRerankDocument,
    includeGlobalSourceCandidate,
    limitPerSource,
    linearScoreFusion,
    preserveSourceRanking,
    reciprocalRankFusion,
    replaceSourceRepresentatives,
    selectLexicalCandidates
} from '../../rag/retrievalPipeline.js';
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

test('linear score fusion normalizes incomparable score ranges', () => {
    const fused = linearScoreFusion(
        [0.01, 0.02, 0.03],
        [-5, 0, 1],
        0.75
    );

    assert.deepEqual(fused.map(value => Number(value.toFixed(4))), [0, 0.75, 1]);
    assert.deepEqual(linearScoreFusion([1, 1], [2, 2], 0.5), [0.5, 0.5]);
    assert.throws(() => linearScoreFusion([1], [1, 2], 0.5), /equal lengths/);
});

test('metadata-prefixed rerank documents expose source, title, and tags', () => {
    const document = formatRerankDocument({
        source: 'raw/2021-01-04 weekly.md',
        titlePath: ['Project', 'Progress'],
        tags: ['baidu', 'kg'],
        text: 'Reuse card data.'
    }, 'metadata-prefixed');

    assert.match(document, /source: raw\/2021-01-04 weekly\.md/);
    assert.match(document, /title: Project > Progress/);
    assert.match(document, /tags: baidu, kg/);
    assert.match(document, /\n\nReuse card data\.$/);
});

test('source-local lexical prefilter can use dates from source metadata', () => {
    const candidates = selectLexicalCandidates('2021-01-04 站会进展', [
        { id: 'wrong', source: 'raw/2021-01-11 本周事项进展.md', text: '站会进展', start: 0, end: 4 },
        { id: 'right', source: 'raw/2021-01-04 本周事项进展.md', text: '站会进展', start: 0, end: 4 }
    ], 1);

    assert.equal(candidates[0]?.id, 'right');
});

test('source-local candidates always include the global source winner without duplication', () => {
    const lexical = [
        result('local-1', 'a.md', 0),
        result('local-2', 'a.md', 0)
    ];
    const global = result('global-best', 'a.md', 0);

    assert.deepEqual(
        includeGlobalSourceCandidate(lexical, global).map(candidate => candidate.id),
        ['local-1', 'local-2', 'global-best']
    );
    assert.deepEqual(
        includeGlobalSourceCandidate([global, ...lexical], global).map(candidate => candidate.id),
        ['global-best', 'local-1', 'local-2']
    );
});

test('source-local candidates can inherit their source global ranking', () => {
    const preserved = preserveSourceRanking([
        { ...result('local-a', 'a.md', 0), fusionScore: 0.01, chunkRerankScore: -5 },
        { ...result('local-b', 'b.md', 0), fusionScore: 0.01, chunkRerankScore: 3 }
    ], [
        { ...result('global-a', 'a.md', 0), fusionScore: 0.02, chunkRerankScore: 10 },
        { ...result('global-b', 'b.md', 0), fusionScore: 0.03, chunkRerankScore: 2 }
    ]);

    assert.deepEqual(preserved.map(candidate => candidate.id), ['local-a', 'local-b']);
    assert.equal(preserved[0]?.chunkRerankScore, -5);
    assert.equal(preserved[0]?.chunkRankingScore, 10);
});

test('source-preserving merge replaces rather than appends a source representative', () => {
    const primary = [
        { ...result('a-wrong', 'a.md', 0), fusionScore: 0.03, chunkRerankScore: 10 },
        { ...result('b-best', 'b.md', 0), fusionScore: 0.02, chunkRerankScore: 9 },
        { ...result('a-local', 'a.md', 0), fusionScore: 0.01, chunkRerankScore: 1 }
    ];
    const replacement = {
        ...result('a-local', 'a.md', 0),
        fusionScore: 0.01,
        chunkRerankScore: 1,
        chunkRankingScore: 10
    };

    const merged = replaceSourceRepresentatives(primary, [replacement]);

    assert.deepEqual(merged.map(candidate => candidate.id), ['a-local', 'b-best']);
    assert.equal(merged.filter(candidate => candidate.source === 'a.md').length, 1);
});

test('source aggregation keeps one ranked candidate with global and local text', () => {
    const aggregated = aggregateSourceCandidates([
        {
            ...result('global', 'a.md', 0),
            text: 'global answer',
            start: 0,
            end: 13,
            fusionScore: 0.03,
            chunkRerankScore: 10,
            chunkRankingScore: 10
        },
        {
            ...result('global-only', 'b.md', 1),
            text: 'outside local source set',
            start: 0,
            end: 24,
            fusionScore: 0.04,
            chunkRerankScore: 30,
            chunkRankingScore: 30
        }
    ], [{
        ...result('local', 'a.md', 0),
        text: 'local answer',
        start: 100,
        end: 112,
        fusionScore: 0.01,
        chunkRerankScore: 1,
        chunkRankingScore: 20
    }]);

    assert.equal(aggregated.length, 2);
    assert.equal(aggregated[0]?.id, 'global-only');
    const sourceAggregate = aggregated.find(candidate => candidate.source === 'a.md');
    assert.match(sourceAggregate!.text, /global answer\n\nlocal answer/);
    assert.equal(sourceAggregate?.chunkRankingScore, 20);
    assert.deepEqual(sourceAggregate?.constituentAnchorIds, ['global', 'local']);
});

test('aggregate evidence expansion uses real constituent anchor ids', async () => {
    const chunks = [
        { ...result('before-global', 'a.md', 0), text: 'before-global', start: 0, end: 13 },
        { ...result('global', 'a.md', 0), text: 'global', start: 13, end: 19 },
        { ...result('local', 'a.md', 0), text: 'local', start: 100, end: 105 },
        { ...result('after-local', 'a.md', 0), text: 'after-local', start: 105, end: 116 }
    ];
    const [anchor] = aggregateSourceCandidates([
        { ...chunks[1]!, fusionScore: 0.03, chunkRankingScore: 10 }
    ], [
        { ...chunks[2]!, fusionScore: 0.01, chunkRankingScore: 20 }
    ]);

    const evidence = await assembleEvidenceWindows([anchor!], {
        findBySource: async () => chunks.map(chunk => ({ ...chunk, vector: [1] }))
    }, 1);

    assert.deepEqual(evidence[0]?.chunkIds, ['before-global', 'global', 'local', 'after-local']);
    assert.match(evidence[0]!.text, /before-global[\s\S]+after-local/);
});
