import assert from 'node:assert/strict';
import test from 'node:test';
import { prioritizeWikiMatches } from '../../rag/ranking.js';
import { SearchResult } from '../../rag/types.js';

function result(source: string, score: number): SearchResult {
    return {
        id: `${source}#1`,
        source,
        text: source,
        start: 0,
        end: source.length,
        vector: {},
        score
    };
}

test('prioritizeWikiMatches ranks maintained wiki above higher-scoring raw sources', () => {
    const matches = prioritizeWikiMatches([
        result('raw/agent.md', 0.95),
        result('wiki/agent.md', 0.3),
        result('wiki/decision.md', 0.8)
    ], 2);

    assert.deepEqual(matches.map(match => match.source), [
        'wiki/decision.md',
        'wiki/agent.md'
    ]);
});
