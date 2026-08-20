import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeEvidencePolicy } from '../../context/runtimeEvidencePolicy.js';

const assessment = {
    state: 'partial' as const,
    reasons: ['存在被截断的证据'],
    evidenceCount: 2,
    distinctSources: 1,
    citedCount: 2,
    truncatedCount: 1,
    conflictedCount: 0,
    lowAuthorityCount: 0
};

test('RuntimeEvidencePolicy enforces a generic RAG call budget without gold answers', () => {
    const policy = new RuntimeEvidencePolicy(2);
    assert.equal(policy.canCallRag(), true);
    policy.recordRagCall();
    assert.equal(policy.snapshot(assessment).ragCallsRemaining, 1);
    policy.recordRagCall();
    assert.equal(policy.canCallRag(), false);
    assert.equal(policy.snapshot(assessment).ragBudgetExhausted, true);
    assert.match(policy.buildModelFeedback(assessment), /不得继续检索/);

    policy.reset();
    assert.equal(policy.snapshot(assessment).ragCallsUsed, 0);
});

test('RuntimeEvidencePolicy rejects invalid budgets', () => {
    assert.throws(() => new RuntimeEvidencePolicy(0), /positive integer/);
});

test('RuntimeEvidencePolicy forces abstention only after an empty RAG search', () => {
    const policy = new RuntimeEvidencePolicy(2);
    policy.recordRagCall();
    const noEvidence = { ...assessment, state: 'insufficient' as const, evidenceCount: 0, distinctSources: 0, citedCount: 0, truncatedCount: 0 };

    const forced = policy.finalizeAnswer('The passport number is X123.', noEvidence);
    assert.equal(forced.action, 'forced-abstention');
    assert.match(forced.content, /无法确认/);

    const preserved = policy.finalizeAnswer('未找到护照号码，无法确认。', noEvidence);
    assert.equal(preserved.action, 'allow');
});
