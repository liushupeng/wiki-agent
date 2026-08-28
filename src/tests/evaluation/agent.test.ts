import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { collectAgentTraceMetrics, parseJsonlV2, scoreAgentAnswer, selectAgentEvalQuestions, summarizeAgentResultsByCategory, validateAgentEvalQuestions } from '../../evaluation/agent.js';

const traceId = 'a'.repeat(32);

test('collectAgentTraceMetrics reads JSONL v2 evidence, latency, tool metrics, and failures', () => {
    const records = parseJsonlV2([
        start('run', 'wiki_agent.run', '2026-01-01T00:00:00.000Z'),
        start('step', 'wiki_agent.step.1', '2026-01-01T00:00:01.000Z'),
        start('model', 'gen_ai.chat', '2026-01-01T00:00:01.100Z'),
        end('model', 'ok', '2026-01-01T00:00:01.900Z', {
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 25,
            'gen_ai.usage.total_tokens': 125,
            'gen_ai.usage.input_tokens.estimated': 110,
            'gen_ai.usage.output_tokens.estimated': 30
        }),
        start('search', 'rag.search', '2026-01-01T00:00:02.000Z'),
        event('search', 'retrieval.result', '2026-01-01T00:00:03.000Z', {
            'gen_ai.retrieval.documents': JSON.stringify([
                { rank: 1, source: 'raw/expected.md', score: 0.9 },
                { rank: 2, source: 'raw/other.md', score: 0.8 }
            ])
        }),
        end('search', 'ok', '2026-01-01T00:00:03.100Z'),
        start('read', 'rag.read_note', '2026-01-01T00:00:03.000Z', {
            'wiki_agent.rag.note_path': 'raw/read.md'
        }),
        end('read', 'ok', '2026-01-01T00:00:04.000Z'),
        start('rag-tool', 'tool.execute', '2026-01-01T00:00:02.000Z', { 'tool.name': 'search_notes' }),
        end('rag-tool', 'ok', '2026-01-01T00:00:03.000Z'),
        start('failed-tool', 'tool.execute', '2026-01-01T00:00:04.000Z', { 'tool.name': 'read_file' }),
        end('failed-tool', 'error', '2026-01-01T00:00:05.000Z', {
            'tool.status': 'execution_failed',
            'error.message': 'permission denied'
        }),
        end('run', 'ok', '2026-01-01T00:00:06.250Z', {
            'wiki_agent.termination_reason': 'completed'
        })
    ].map(record => JSON.stringify(record)).join('\n'));

    const metrics = collectAgentTraceMetrics(records);

    assert.equal(metrics.stepCount, 1);
    assert.equal(metrics.totalLatencyMs, 6250);
    assert.equal(metrics.totalToolCallCount, 2);
    assert.equal(metrics.ragToolCallCount, 1);
    assert.equal(metrics.ragToolUsageRate, 0.5);
    assert.deepEqual(metrics.evidenceSources, ['raw/expected.md', 'raw/other.md', 'raw/read.md']);
    assert.deepEqual(metrics.toolFailures, [{ name: 'read_file', status: 'execution_failed', error: 'permission denied' }]);
    assert.equal(metrics.terminationReason, 'completed');
    assert.deepEqual(metrics.tokenUsage, {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        estimatedInputTokens: 110,
        estimatedOutputTokens: 30
    });
});

test('scoreAgentAnswer requires source evidence and 60 percent term coverage', () => {
    const result = scoreAgentAnswer({
        id: 'example',
        question: 'example question',
        expectedSource: 'expected.md',
        expectedTerms: ['value', 'cycle', 'compound']
    }, 'Value investing follows the cycle.', {
        stepCount: 2,
        totalToolCallCount: 1,
        ragToolCallCount: 1,
        ragToolUsageRate: 1,
        toolFailures: [],
        evidenceSources: ['raw/expected.md']
    });

    assert.deepEqual(result.matchedTerms, ['value', 'cycle']);
    assert.equal(result.termCoverage, 0.6667);
    assert.equal(result.sourceHit, true);
    assert.deepEqual(result.sourceEvidence, ['raw/expected.md']);
    assert.equal(result.passed, true);
});

test('scoreAgentAnswer accepts any configured evidence source', () => {
    const result = scoreAgentAnswer({
        id: 'example',
        question: 'example question',
        expectedSources: ['raw/expected.md', 'wiki/expected.md'],
        expectedTerms: ['value']
    }, 'Value.', {
        stepCount: 1,
        totalToolCallCount: 1,
        ragToolCallCount: 1,
        ragToolUsageRate: 1,
        toolFailures: [],
        evidenceSources: ['wiki/expected.md']
    });

    assert.equal(result.sourceHit, true);
    assert.deepEqual(result.sourceEvidence, ['wiki/expected.md']);
    assert.equal(result.passed, true);
});

test('parseJsonlV2 rejects invalid records', () => {
    assert.throws(() => parseJsonlV2('{"schemaVersion":1}\n'), /unsupported trace schema at line 1/);
    assert.throws(() => parseJsonlV2('not-json\n'), /invalid JSONL at line 1/);
});

test('selectAgentEvalQuestions is reproducible and validates requested IDs', () => {
    const questions = ['a', 'b', 'c', 'd'].map(id => ({ id, question: id }));
    assert.deepEqual(
        selectAgentEvalQuestions(questions, { randomCount: 2, seed: 'fixed' }).map(question => question.id),
        selectAgentEvalQuestions(questions, { randomCount: 2, seed: 'fixed' }).map(question => question.id)
    );
    assert.deepEqual(selectAgentEvalQuestions(questions, { questionIds: ['c', 'a'] }).map(question => question.id), ['a', 'c']);
    assert.throws(() => selectAgentEvalQuestions(questions, { questionIds: ['missing'] }), /unknown --question-ids/);
});

test('summarizeAgentResultsByCategory groups latency and failure metrics', () => {
    const sample = (category: string, passed: boolean) => scoreAgentAnswer({ id: category, category, question: category }, '', {
        stepCount: 2, totalLatencyMs: 10, totalToolCallCount: 0, ragToolCallCount: 0, ragToolUsageRate: 0, toolFailures: [], evidenceSources: []
    });
    const summary = summarizeAgentResultsByCategory([sample('a', true), sample('b', false)]);
    assert.equal(summary.a?.total, 1);
    assert.equal(summary.b?.averageSteps, 2);
});

test('validateAgentEvalQuestions preserves E2E rubrics and keeps legacy questions compatible', async () => {
    const questions = validateAgentEvalQuestions(JSON.parse(
        await fs.readFile('evaluation/e2e/questions.json', 'utf-8')
    ));
    assert.equal(questions.length, 12);
    assert.equal(questions.filter(question => question.rubric?.expectedBehavior === 'insufficient-evidence').length, 2);
    assert.equal(questions.filter(question => question.contract?.evidence?.requireAllExpectedSources).length, 2);
    assert.deepEqual(validateAgentEvalQuestions([{ id: 'legacy', question: 'legacy question' }]), [
        { id: 'legacy', question: 'legacy question' }
    ]);
});

test('online-trace provenance is validated and reports replay environment differences', () => {
    const [question] = validateAgentEvalQuestions([{
        id: 'badcase-1',
        question: 'question',
        provenance: {
            source: 'online-trace',
            traceId: 'trace-1',
            observedAt: '2026-08-25T00:00:00.000Z',
            model: 'original-model',
            retrievalProfiles: ['balanced-v1']
        }
    }]);
    const result = scoreAgentAnswer(question!, 'answer', {
        stepCount: 1,
        totalToolCallCount: 0,
        ragToolCallCount: 0,
        ragToolUsageRate: 0,
        toolFailures: [],
        evidenceSources: [],
        model: 'candidate-model',
        retrievalProfiles: ['deep-v1'],
        retrievalVariants: [],
        indexIdentities: []
    });

    assert.equal(result.provenance?.traceId, 'trace-1');
    assert.equal(result.replayEnvironment?.matchesOriginal, false);
    assert.equal(result.replayEnvironment?.differences.length, 2);
});

function start(spanId: string, name: string, at: string, attributes: Record<string, unknown> = {}) {
    return {
        type: 'span_start' as const,
        schemaVersion: 2 as const,
        traceId,
        spanId,
        name,
        startedAt: at,
        attributes,
        at
    };
}

function end(spanId: string, status: string, at: string, attributes: Record<string, unknown> = {}) {
    return {
        type: 'span_end' as const,
        schemaVersion: 2 as const,
        traceId,
        spanId,
        status,
        endedAt: at,
        attributes,
        at
    };
}

function event(spanId: string, name: string, at: string, attributes: Record<string, unknown> = {}) {
    return {
        type: 'span_event' as const,
        schemaVersion: 2 as const,
        traceId,
        spanId,
        name,
        attributes,
        at
    };
}
