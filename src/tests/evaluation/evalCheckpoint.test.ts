import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    EvalQuestionCheckpoint,
    EvalRunManifest,
    loadEvalQuestionCheckpoint,
    validateEvalResumeManifest,
    writeJsonAtomic
} from '../../evaluation/evalCheckpoint.js';

test('evaluation checkpoint is atomic, recoverable, and identity checked', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-eval-checkpoint-'));
    const manifest = sampleManifest();
    await writeJsonAtomic(path.join(directory, 'run-manifest.json'), manifest);
    await validateEvalResumeManifest(directory, { ...manifest, createdAt: 'later' });
    await assert.rejects(
        validateEvalResumeManifest(directory, { ...manifest, model: 'other-model' }),
        /does not match/
    );

    const checkpoint = sampleCheckpoint();
    const checkpointPath = path.join(directory, 'raw-wiki', 'question', 'result.json');
    await writeJsonAtomic(checkpointPath, checkpoint);
    assert.deepEqual(
        await loadEvalQuestionCheckpoint(checkpointPath, 'raw-wiki', 'question'),
        checkpoint
    );
    await assert.rejects(
        loadEvalQuestionCheckpoint(checkpointPath, 'raw-wiki', 'other-question'),
        /mismatched/
    );
    assert.equal(await loadEvalQuestionCheckpoint(path.join(directory, 'missing.json'), 'raw-wiki', 'question'), undefined);
});

function sampleManifest(): EvalRunManifest {
    return {
        schemaVersion: 1,
        questionsFile: 'evaluation/e2e/questions.json',
        questionSetSha256: 'hash',
        selectedQuestionIds: ['question'],
        modes: ['raw-wiki'],
        profile: 'bm25-v1',
        model: 'deepseek-v4-pro',
        maxSteps: 8,
        maxOutputTokens: 2048,
        gitCommit: 'commit',
        createdAt: '2026-08-19T00:00:00.000Z'
    };
}

function sampleCheckpoint(): EvalQuestionCheckpoint {
    return {
        schemaVersion: 1,
        mode: 'raw-wiki',
        questionId: 'question',
        traceId: 'trace',
        traceFile: 'raw-wiki/question/attempts/attempt/traces',
        completedAt: '2026-08-19T00:00:00.000Z',
        result: {
            id: 'question',
            question: 'question',
            answer: 'answer',
            expectedTerms: [],
            matchedTerms: [],
            termCoverage: 1,
            sourceHit: true,
            sourceEvidence: [],
            passed: true,
            trace: {
                stepCount: 2,
                totalToolCallCount: 1,
                ragToolCallCount: 1,
                ragToolUsageRate: 1,
                toolFailures: [],
                evidenceSources: []
            }
        }
    };
}
