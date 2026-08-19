import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewAnnotations, summarizeReviewAnnotations } from '../../evaluation/reviewSummary.js';

const headers = [
    'reviewId',
    'questionId',
    'expectedBehavior',
    'correctness',
    'completeness',
    'groundedness',
    'citationAccuracy',
    'abstention',
    'overallPass',
    'failureTag',
    'notes'
].join(',');

test('review summary reports dimensions, abstention, and failure attribution', () => {
    const annotations = parseReviewAnnotations([
        headers,
        'r1,q1,answer,1,1,1,1,na,1,,"complete"',
        'r2,q2,insufficient-evidence,0,1,0,na,0,0,"failed_abstention;hallucination","invented, amount"'
    ].join('\n'));
    const summary = summarizeReviewAnnotations(annotations);

    assert.equal(summary.total, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.passRate, 0.5);
    assert.deepEqual(summary.dimensions.citationAccuracy, { rated: 1, passed: 1, passRate: 1 });
    assert.deepEqual(summary.dimensions.abstention, { rated: 1, passed: 0, passRate: 0 });
    assert.deepEqual(summary.failureTags, { failed_abstention: 1, hallucination: 1 });
    assert.deepEqual(summary.failedQuestionIds, ['q2']);
});

test('review annotations reject incomplete scores and failures without attribution', () => {
    assert.throws(() => parseReviewAnnotations([
        headers,
        'r1,q1,answer,,1,1,1,na,1,,'
    ].join('\n')), /correctness must be/);
    assert.throws(() => parseReviewAnnotations([
        headers,
        'r1,q1,answer,0,1,1,1,na,0,,'
    ].join('\n')), /requires failureTag/);
});
