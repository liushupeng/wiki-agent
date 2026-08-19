import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTaskContract } from '../../evaluation/taskContract.js';
import { JsonlV2Record, parseJsonlV2 } from '../../evaluation/trajectoryModel.js';
import { verifyTrajectory } from '../../evaluation/trajectoryVerifier.js';

test('validateTaskContract rejects invalid thresholds and empty tool names', () => {
    assert.throws(() => validateTaskContract({ schemaVersion: 1, answer: { minTermCoverage: 2 } }), /between 0 and 1/);
    assert.throws(() => validateTaskContract({ schemaVersion: 1, tools: { mustUseAny: [''] } }), /non-empty strings/);
});

test('verifyTrajectory passes a compliant knowledge lookup', () => {
    const report = verifyTrajectory({
        contract: {
            schemaVersion: 1,
            strictness: 'hard',
            answer: { minTermCoverage: 0.5 },
            evidence: { expectedSources: ['agent.md'], requireReadNote: true, minimumSufficiency: 'sufficient' },
            tools: { mustUseAll: ['search_notes', 'read_note'], maxCalls: 3 },
            trajectory: { maxSteps: 3, allowedTerminationReasons: ['completed'], forbidRetryLimitReached: true },
            safety: { forbidPermissionDeny: true, forbidApprovalDenied: true }
        },
        question: { expectedTerms: ['retrieval', 'planning'] },
        answer: 'retrieval is combined with planning',
        records: happyTrace()
    });

    assert.equal(report.passed, true);
    assert.deepEqual(report.summary.toolNames, ['search_notes', 'read_note']);
    assert.deepEqual(report.summary.failedDimensions, []);
});

test('verifyTrajectory catches forbidden tools, missing group loading, and unsafe termination', () => {
    const records = happyTrace().map(record => record.type === 'span_end' && record.spanId === 'run'
        ? { ...record, attributes: { 'wiki_agent.termination_reason': 'max_loop_steps' } }
        : record);
    records.splice(-1, 0,
        start('shell', 'tool.execute', { 'tool.name': 'execute_command', 'wiki_agent.step': 2 }),
        end('shell', 'ok', { 'tool.status': 'success' })
    );
    const report = verifyTrajectory({
        contract: {
            schemaVersion: 1,
            tools: {
                forbid: ['execute_command'],
                requireLoadGroupBefore: [{ group: 'shell', tools: ['execute_command'] }]
            },
            trajectory: { allowedTerminationReasons: ['completed'] }
        },
        question: {},
        answer: '',
        records
    });

    assert.equal(report.passed, false);
    assert.deepEqual(report.summary.failedDimensions, [
        'tools.forbid',
        'tools.group_before.shell',
        'trajectory.termination'
    ]);
});

test('parseJsonlV2 rejects unsupported trace records', () => {
    assert.throws(() => parseJsonlV2('{"schemaVersion":1}\n'), /schemaVersion=2/);
});

test('verifyTrajectory detects circular identical failures without a model judge', () => {
    const records: JsonlV2Record[] = [
        start('run-loop', 'wiki_agent.run'),
        start('fail-1', 'tool.execute', {
            'tool.name': 'read_note',
            'tool.arguments.sha256': 'same-arguments'
        }),
        end('fail-1', 'error', { 'tool.status': 'runtime_error' }),
        start('fail-2', 'tool.execute', {
            'tool.name': 'read_note',
            'tool.arguments.sha256': 'same-arguments'
        }),
        end('fail-2', 'error', { 'tool.status': 'runtime_error' }),
        end('run-loop', 'ok', { 'wiki_agent.termination_reason': 'completed' })
    ];
    const report = verifyTrajectory({
        contract: {
            schemaVersion: 1,
            trajectory: { maxToolFailures: 0, forbidRepeatedFailures: true }
        },
        question: {},
        answer: 'done',
        records
    });
    assert.deepEqual(report.summary.failedDimensions, [
        'trajectory.tool_failures',
        'trajectory.repeated_failures'
    ]);
});

test('verifyTrajectory validates abstention phrases and all expected sources', () => {
    const abstained = verifyTrajectory({
        contract: {
            schemaVersion: 1,
            answer: {
                requiredPhrasesAny: ['没有找到', '证据不足'],
                forbiddenPhrases: ['预算为']
            }
        },
        question: {},
        answer: '知识库中没有找到相关预算，证据不足。',
        records: happyTrace()
    });
    assert.equal(abstained.passed, true);

    const missingSource = verifyTrajectory({
        contract: {
            schemaVersion: 1,
            evidence: {
                expectedSources: ['agent.md', 'second.md'],
                requireAllExpectedSources: true
            }
        },
        question: {},
        answer: '',
        records: happyTrace()
    });
    assert.equal(missingSource.passed, false);
    assert.deepEqual(missingSource.summary.failedDimensions, ['evidence.all_sources']);
});

function happyTrace(): JsonlV2Record[] {
    return [
        start('run', 'wiki_agent.run'),
        start('step1', 'wiki_agent.step.1'),
        start('search', 'tool.execute', {
            'tool.name': 'search_notes',
            'tool.call_id': 'call-search',
            'wiki_agent.step': 1
        }),
        end('search', 'ok', { 'tool.status': 'success' }),
        start('rag-search', 'rag.search'),
        event('rag-search', 'retrieval.result', {
            'gen_ai.retrieval.documents': JSON.stringify([{ source: 'notes/agent.md' }])
        }),
        end('rag-search', 'ok'),
        end('step1', 'ok'),
        start('step2', 'wiki_agent.step.2'),
        start('read', 'tool.execute', {
            'tool.name': 'read_note',
            'tool.call_id': 'call-read',
            'wiki_agent.step': 2
        }),
        end('read', 'ok', { 'tool.status': 'success' }),
        start('rag-read', 'rag.read_note', { 'wiki_agent.rag.note_path': 'notes/agent.md' }),
        end('rag-read', 'ok'),
        end('step2', 'ok'),
        end('run', 'ok', { 'wiki_agent.termination_reason': 'completed' })
    ];
}

function start(spanId: string, name: string, attributes: Record<string, unknown> = {}): JsonlV2Record {
    return {
        type: 'span_start',
        schemaVersion: 2,
        traceId: 'trace',
        spanId,
        name,
        at: `2026-01-01T00:00:${String(counter++).padStart(2, '0')}.000Z`,
        startedAt: `2026-01-01T00:00:00.000Z`,
        attributes
    };
}

function end(spanId: string, status: string, attributes: Record<string, unknown> = {}): JsonlV2Record {
    return {
        type: 'span_end',
        schemaVersion: 2,
        traceId: 'trace',
        spanId,
        status,
        at: `2026-01-01T00:01:${String(counter++).padStart(2, '0')}.000Z`,
        endedAt: `2026-01-01T00:01:00.000Z`,
        attributes
    };
}

function event(spanId: string, name: string, attributes: Record<string, unknown>): JsonlV2Record {
    return {
        type: 'span_event',
        schemaVersion: 2,
        traceId: 'trace',
        spanId,
        name,
        at: `2026-01-01T00:00:${String(counter++).padStart(2, '0')}.000Z`,
        attributes
    };
}

let counter = 0;
