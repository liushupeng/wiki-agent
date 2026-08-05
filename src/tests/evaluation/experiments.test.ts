import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintSourceConfig, getEvaluationExperiment, parseEvaluationMode } from '../../evaluation/experiments.js';

test('source config fingerprint is stable across object key ordering', () => {
    assert.equal(
        fingerprintSourceConfig({ sources: [{ name: 'raw', root: 'notes' }] }),
        fingerprintSourceConfig({ sources: [{ root: 'notes', name: 'raw' }] })
    );
});

test('evaluation experiments select separate variants of the same profile', () => {
    const raw = getEvaluationExperiment('raw-only');
    const rawWiki = getEvaluationExperiment('raw-wiki');
    assert.equal(raw.indexProfile, rawWiki.indexProfile);
    assert.notEqual(raw.indexVariant, rawWiki.indexVariant);
    assert.deepEqual(parseEvaluationMode('both'), ['raw-only', 'raw-wiki']);
});
