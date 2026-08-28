import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonlV2Record } from '../../evaluation/trajectoryModel.js';
import {
    buildRunQualitySample,
    candidateSignals,
    summarizeRunQuality
} from '../../observability/runQuality.js';

test('buildRunQualitySample extracts quality, retrieval, and artifact facts', () => {
    const records: JsonlV2Record[] = [
        start('run', 'wiki_agent.run', {
            'wiki_agent.instruction': 'question',
            'wiki_agent.instruction.sha256': 'query-sha',
            'gen_ai.request.model': 'test-model',
            'wiki_agent.build_id': 'build-1'
        }),
        start('tool', 'tool.execute'),
        start('rag', 'rag.search', {
            'wiki_agent.rag.profile': 'balanced-v1',
            'wiki_agent.rag.variant': 'raw-wiki'
        }),
        event('rag', 'retrieval.runtime', {
            'wiki_agent.rag.retriever_cache_hit': true,
            'wiki_agent.rag.fallback_used': true
        }),
        event('rag', 'retrieval.result', {
            'wiki_agent.rag.match_count': 0,
            'wiki_agent.rag.latency_ms': 42,
            'wiki_agent.rag.index_identity': '{"id":"index-1"}'
        }),
        end('rag', 'ok'),
        end('tool', 'error'),
        event('run', 'final_answer.policy', {
            'wiki_agent.final_answer.action': 'forced-abstention'
        }),
        end('run', 'ok', {
            'wiki_agent.termination_reason': 'completed',
            'wiki_agent.rag.budget_exhausted': true,
            'evidence.state': 'insufficient',
            'evidence.count': 0,
            'evidence.distinct_sources': 0,
            'evidence.cited_count': 0,
            'wiki_agent.run_artifact.path': 'var/run.json',
            'wiki_agent.run_artifact.sha256': 'artifact-sha'
        })
    ];
    const sample = buildRunQualitySample(records, 'trace.jsonl');

    assert.equal(sample?.model, 'test-model');
    assert.equal(sample?.fallbackCount, 1);
    assert.equal(sample?.emptyRetrievals, 1);
    assert.deepEqual(sample?.retrievalLatenciesMs, [42]);
    assert.deepEqual(sample?.retrievalProfiles, ['balanced-v1']);
    assert.equal(sample?.finalAnswerAction, 'forced-abstention');
    assert.deepEqual(candidateSignals(sample!), [
        'tool_failure',
        'rag_budget_exhausted',
        'insufficient_evidence',
        'fallback',
        'forced_abstention',
        'empty_retrieval'
    ]);
});

test('summarizeRunQuality excludes no-RAG runs from evidence rates', () => {
    const knowledge = buildRunQualitySample([
        start('run-1', 'wiki_agent.run'),
        start('rag-1', 'rag.search', { 'wiki_agent.rag.profile': 'balanced-v1' }),
        event('rag-1', 'retrieval.result', {
            'wiki_agent.rag.match_count': 1,
            'wiki_agent.rag.latency_ms': 100
        }),
        end('rag-1', 'ok'),
        end('run-1', 'ok', {
            'wiki_agent.termination_reason': 'completed',
            'evidence.state': 'partial'
        })
    ])!;
    const noRag = buildRunQualitySample([
        start('run-2', 'wiki_agent.run'),
        end('run-2', 'ok', {
            'wiki_agent.termination_reason': 'completed',
            'evidence.state': 'insufficient'
        })
    ])!;
    const summary = summarizeRunQuality([knowledge, noRag]);

    assert.equal(summary.runs, 2);
    assert.equal(summary.knowledgeRuns, 1);
    assert.equal(summary.sli.evidence.partialRate, 1);
    assert.equal(summary.sli.evidence.insufficientRate, 0);
    assert.equal(summary.sli.retrievalLatencyMs.p95, 100);
    assert.equal(summary.byRetrievalProfile['balanced-v1']?.runs, 1);
});

function start(spanId: string, name: string, attributes: Record<string, unknown> = {}): JsonlV2Record {
    return {
        type: 'span_start',
        schemaVersion: 2,
        traceId: spanId.startsWith('run') ? spanId : 'run',
        spanId,
        name,
        startedAt: '2026-08-25T00:00:00.000Z',
        at: '2026-08-25T00:00:00.000Z',
        attributes
    };
}

function event(spanId: string, name: string, attributes: Record<string, unknown>): JsonlV2Record {
    return {
        type: 'span_event',
        schemaVersion: 2,
        traceId: spanId.startsWith('run') ? spanId : 'run',
        spanId,
        name,
        at: '2026-08-25T00:00:00.500Z',
        attributes
    };
}

function end(spanId: string, status: string, attributes: Record<string, unknown> = {}): JsonlV2Record {
    return {
        type: 'span_end',
        schemaVersion: 2,
        traceId: spanId.startsWith('run') ? spanId : 'run',
        spanId,
        status,
        endedAt: '2026-08-25T00:00:01.000Z',
        at: '2026-08-25T00:00:01.000Z',
        attributes
    };
}
