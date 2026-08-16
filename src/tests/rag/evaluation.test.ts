import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    createGrepEvalRetriever,
    createVectorEvalRetriever,
    evaluateRetriever,
    scoreQuestion
} from '../../rag/evaluation.js';
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
    assert.equal(result.strictPassed, true);
    assert.equal(result.sourceHit, true);
    assert.equal(result.termScore, 1);
    assert.equal(result.sourceTermScore, 1);
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

test('scoreQuestion does not count terms from unrelated sources as a strict pass', () => {
    const result = scoreQuestion({
        question: 'how is the project built and profiled?',
        expectedSource: 'project/README.md',
        expectedTerms: ['cmake', 'pprof', 'FlameGraph', 'graphviz']
    }, [
        { ...matches[0], source: 'project/README.md', text: 'Build with cmake.' },
        { ...matches[0], source: 'observability.md', text: 'Use pprof, FlameGraph, and graphviz.' }
    ]);

    assert.equal(result.passed, true);
    assert.equal(result.termScore, 1);
    assert.equal(result.strictPassed, false);
    assert.equal(result.sourceTermScore, 0.25);
});

test('scoreQuestion accepts any configured evidence source', () => {
    const result = scoreQuestion({
        question: 'why use rag tools?',
        expectedSources: ['raw/agent.md', 'wiki/rag-overview.md'],
        expectedTerms: ['Agent', 'retrieval']
    }, [{ ...matches[0], source: 'wiki/rag-overview.md' }]);

    assert.equal(result.sourceHit, true);
    assert.equal(result.passed, true);
    assert.deepEqual(result.expectedSources, ['raw/agent.md', 'wiki/rag-overview.md']);
});

test('scoreQuestion records the expected source rank at every available pipeline stage', () => {
    const wrong = { ...matches[0], id: 'wrong#1', source: 'wrong.md' };
    const expected = { ...matches[0], id: 'agent#1', source: 'agent.md' };
    const result = scoreQuestion({
        question: 'why use rag tools?',
        expectedSource: 'agent.md',
        expectedTerms: ['Agent']
    }, [wrong, expected], [wrong, expected], {
        sparse: [expected, wrong],
        dense: [wrong],
        fusion: [wrong, expected],
        chunkRerank: [expected, wrong],
        evidenceAssembly: [wrong, expected],
        evidenceRerank: [wrong],
        final: [wrong, expected]
    });

    assert.deepEqual(result.stageRanks, {
        sparse: 1,
        dense: null,
        fusion: 2,
        chunkRerank: 1,
        evidenceAssembly: 2,
        evidenceRerank: null,
        final: 2
    });
    assert.deepEqual(result.stageDiagnostics?.fusion, {
        sourceRank: 2,
        contentRank: 2,
        bestTermCoverage: 1
    });
    assert.deepEqual(result.stageDiagnostics?.dense, {
        sourceRank: null,
        contentRank: null,
        bestTermCoverage: 0
    });
});

test('evaluateRetriever searches vector queries and summarizes accuracy', async () => {
    const searchedQueries: string[] = [];
    const progress: string[] = [];
    const vectorRetriever = {
        name: 'vector',
        async search(item: { question: string }): Promise<SearchResult[]> {
            const query = item.question;
            searchedQueries.push(query);
            return query.includes('hit') ? matches : [];
        }
    };

    const summary = await evaluateRetriever([
        { question: 'hit question', expectedSource: 'agent.md', expectedTerms: ['Agent'] },
        { question: 'miss question', expectedSource: 'agent.md', expectedTerms: ['Agent'] }
    ], vectorRetriever, 5, event => progress.push(`${event.completed}/${event.total}:${event.question.id}`));

    assert.deepEqual(searchedQueries, ['hit question', 'miss question']);
    assert.deepEqual(progress, ['1/2:question-1', '2/2:question-2']);
    assert.equal(summary.status, 'success');
    assert.equal(summary.retriever, 'vector');
    assert.equal(summary.passed, 1);
    assert.equal(summary.strictPassed, 1);
    assert.equal(summary.total, 2);
    assert.equal(summary.accuracy, 0.5);
});

test('evaluateRetriever passes grep terms to custom retrievers', async () => {
    const searchedQueries: string[] = [];

    const summary = await evaluateRetriever([
        { question: 'what is the agent formula?', grepTerms: ['loop', 'memory', 'tool'], expectedSource: 'agent.md', expectedTerms: ['Agent', 'retrieval'] }
    ], {
        name: 'grep',
        async search(item): Promise<SearchResult[]> {
            searchedQueries.push(item.grepTerms?.join(' ') ?? item.question);
            return matches;
        }
    });

    assert.deepEqual(searchedQueries, ['loop memory tool']);
    assert.equal(summary.retriever, 'grep');
    assert.equal(summary.passed, 1);
    assert.equal(summary.accuracy, 1);
});

test('createVectorEvalRetriever applies wiki-first ranking only when requested', async () => {
    const requestedLimits: number[] = [];
    const vectorStore = {
        async search(_query: string, topK: number): Promise<SearchResult[]> {
            requestedLimits.push(topK);
            return [
                { ...matches[0], source: 'raw/agent.md', score: 0.9 },
                { ...matches[0], source: 'wiki/agent.md', score: 0.1 }
            ];
        }
    };

    const plainMatches = await createVectorEvalRetriever(vectorStore, { wikiFirst: false })
        .search({ question: 'agent' }, 1);
    const wikiMatches = await createVectorEvalRetriever(vectorStore, { wikiFirst: true })
        .search({ question: 'agent' }, 1);

    assert.deepEqual(requestedLimits, [1, 4]);
    assert.equal(plainMatches[0]?.source, 'raw/agent.md');
    assert.equal(wikiMatches[0]?.source, 'wiki/agent.md');
});

test('createGrepEvalRetriever ranks lines by matched grep terms', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-eval-'));
    await fs.writeFile(path.join(dir, 'partial.md'), 'Raft\n', 'utf-8');
    await fs.writeFile(path.join(dir, 'complete.md'), 'Raft leader safety\n', 'utf-8');
    const retriever = createGrepEvalRetriever([
        { prefix: 'raw', root: dir, kind: 'raw', priority: 50, ignore: [] }
    ], { wikiFirst: false });

    const results = await retriever.search({
        question: 'How does Raft stay safe?',
        grepTerms: ['Raft', 'leader', 'safety']
    }, 2);

    assert.equal(results[0]?.source, 'raw/complete.md');
    assert.equal(results[0]?.score, 1);
    assert.equal(results[1]?.source, 'raw/partial.md');
    assert.equal(results[1]?.score, 1 / 3);
});

