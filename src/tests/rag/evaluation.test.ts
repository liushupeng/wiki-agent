import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRag, evaluateRetriever, scoreQuestion } from '../../rag/evaluation.js';
import { SearchResult } from '../../rag/types.js';

const matches: SearchResult[] = [
    {
        id: 'agent.md#1',
        source: 'agent.md',
        text: 'Agent uses retrieval tools and planning.',
        start: 0,
        end: 40,
        vector: {},
        score: 0.87654
    }
];

test('scoreQuestion passes when expected source and enough terms are matched', () => {
    const result = scoreQuestion({
        question: 'why use rag tools?',
        expectedSource: 'agent.md',
        expectedTerms: ['Agent', 'retrieval', 'planning']
    }, matches);

    assert.equal(result.passed, true);
    assert.equal(result.sourceHit, true);
    assert.equal(result.termScore, 1);
    assert.deepEqual(result.topSources, [{ source: 'agent.md', score: 0.8765 }]);
});

test('scoreQuestion fails when term coverage is below the threshold', () => {
    const result = scoreQuestion({
        question: 'why use rag tools?',
        expectedSource: 'agent.md',
        expectedTerms: ['Agent', 'retrieval', 'missing', 'absent']
    }, matches);

    assert.equal(result.passed, false);
    assert.equal(result.sourceHit, true);
    assert.equal(result.termScore, 0.5);
});

test('evaluateRag searches each question and summarizes accuracy', async () => {
    const searchedQueries: string[] = [];
    const vectorStore = {
        async search(query: string): Promise<SearchResult[]> {
            searchedQueries.push(query);
            return query.includes('hit') ? matches : [];
        }
    };

    const summary = await evaluateRag([
        { question: 'hit question', expectedSource: 'agent.md', expectedTerms: ['Agent'] },
        { question: 'miss question', expectedSource: 'agent.md', expectedTerms: ['Agent'] }
    ], vectorStore);

    assert.deepEqual(searchedQueries, ['hit question', 'miss question']);
    assert.equal(summary.status, 'success');
    assert.equal(summary.retriever, 'vector');
    assert.equal(summary.passed, 1);
    assert.equal(summary.total, 2);
    assert.equal(summary.accuracy, 0.5);
});

test('evaluateRetriever supports custom grep-style query fields', async () => {
    const searchedQueries: string[] = [];

    const summary = await evaluateRetriever([
        { question: 'what is the agent formula?', grepQuery: 'loop memory tool', expectedSource: 'agent.md', expectedTerms: ['Agent', 'retrieval'] }
    ], {
        name: 'grep',
        async search(item): Promise<SearchResult[]> {
            searchedQueries.push(item.grepQuery ?? item.question);
            return matches;
        }
    });

    assert.deepEqual(searchedQueries, ['loop memory tool']);
    assert.equal(summary.retriever, 'grep');
    assert.equal(summary.passed, 1);
    assert.equal(summary.accuracy, 1);
});
