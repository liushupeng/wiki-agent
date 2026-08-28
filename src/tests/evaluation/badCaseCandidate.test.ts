import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createBadCaseCandidate,
    validateBadCaseCandidate
} from '../../evaluation/badCaseCandidate.js';
import type { RunQualitySample } from '../../observability/runQuality.js';

test('createBadCaseCandidate keeps provenance and marks complete artifacts replay-ready', () => {
    const sample = qualitySample();
    const candidate = createBadCaseCandidate(sample, {
        traceId: sample.traceId,
        instruction: '完整问题',
        answer: '原始回答'
    }, new Date('2026-08-25T01:00:00.000Z'));

    assert.equal(candidate?.question, '完整问题');
    assert.equal(candidate?.originalAnswer, '原始回答');
    assert.equal(candidate?.replayReady, true);
    assert.deepEqual(candidate?.failureTypes, ['partial_evidence']);
    assert.equal(validateBadCaseCandidate(candidate).sourceTrace.traceId, 'trace-1');
});

test('createBadCaseCandidate falls back to preview and marks incomplete identity non-replayable', () => {
    const sample = qualitySample();
    delete sample.buildId;
    const candidate = createBadCaseCandidate(sample);

    assert.equal(candidate?.question, '预览问题');
    assert.equal(candidate?.replayReady, false);
});

test('validateBadCaseCandidate rejects candidates without trace identity', () => {
    assert.throws(() => validateBadCaseCandidate({
        schemaVersion: 1,
        id: 'candidate',
        status: 'candidate',
        question: 'question',
        failureTypes: ['partial_evidence'],
        sourceTrace: {}
    }), /traceId/);
});

function qualitySample(): RunQualitySample {
    return {
        traceId: 'trace-1',
        traceFile: 'trace.jsonl',
        startedAt: '2026-08-25T00:00:00.000Z',
        durationMs: 100,
        completed: true,
        terminationReason: 'completed',
        instructionPreview: '预览问题',
        instructionSha256: 'query-sha',
        model: 'model-1',
        buildId: 'build-1',
        stepCount: 2,
        toolCalls: 1,
        toolFailures: 0,
        ragCalls: 1,
        ragCacheHits: 0,
        ragBudgetExhausted: false,
        fallbackCount: 0,
        emptyRetrievals: 0,
        retrievalLatenciesMs: [50],
        retrievalProfiles: ['balanced-v1'],
        retrievalVariants: ['raw-wiki'],
        indexIdentities: ['{"id":"index-1"}'],
        totalTokens: 100,
        evidence: {
            state: 'partial',
            count: 1,
            distinctSources: 1,
            citedCount: 1,
            truncatedCount: 1,
            conflictedCount: 0,
            lowAuthorityCount: 0
        },
        finalAnswerAction: 'allow',
        runArtifact: {
            path: 'var/run.json',
            sha256: 'artifact-sha'
        }
    };
}
