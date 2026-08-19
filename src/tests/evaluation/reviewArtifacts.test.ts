import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileReviewArtifactWriter } from '../../evaluation/reviewArtifacts.js';

test('FileReviewArtifactWriter creates blind review files and internal mapping', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-review-'));
    const result = await new FileReviewArtifactWriter(20).write([{
        id: 'question-1', question: 'What is the answer?',
        rawOnly: fakeResult('raw answer'),
        rawWiki: fakeResult('wiki answer')
    }], directory);
    const review = await fs.readFile(result.reviewJsonlPath, 'utf-8');
    const mapping = await fs.readFile(result.blindMappingPath, 'utf-8');
    const template = await fs.readFile(result.annotationTemplatePath, 'utf-8');
    const html = await fs.readFile(result.reviewHtmlPath, 'utf-8');
    assert.match(review, /"variant":"[AB]"/);
    assert.doesNotMatch(review, /raw-only|raw-wiki/);
    assert.match(mapping, /raw-only/);
    assert.match(template, /correctness,completeness,groundedness,citationAccuracy,abstention,overallPass,failureTag/);
    assert.match(html, /Required facts/);
    assert.ok(result.sha256.length === 64);
});

function fakeResult(answer: string): any {
    return {
        id: 'question-1', question: 'What is the answer?', answer, expectedTerms: [], matchedTerms: [],
        termCoverage: 1, sourceHit: true, sourceEvidence: ['raw/example.md'], passed: true,
        rubric: {
            requiredFacts: ['expected fact'],
            forbiddenClaims: ['forbidden claim'],
            expectedBehavior: 'answer',
            citationRequired: true,
            failureTags: ['wrong_fact']
        },
        trace: { stepCount: 1, totalToolCallCount: 1, ragToolCallCount: 1, ragToolUsageRate: 1, toolFailures: [], evidenceSources: ['raw/example.md'] }
    };
}
