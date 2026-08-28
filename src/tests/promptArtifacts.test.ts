import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writePromptArtifact, writeRunArtifact } from '../trace/artifacts.js';

test('writePromptArtifact redacts sensitive object fields and returns a verifiable reference', async () => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-prompt-artifact-'));
    const reference = await writePromptArtifact({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        model: 'test-model',
        temperature: 0,
        reasoningEffort: 'high',
        messages: [{
            role: 'user',
            content: 'Authorization: Bearer bearer-secret-value api_key=inline-secret sk-1234567890abcdef',
            apiKey: 'should-not-persist'
        }],
        tools: []
    }, artifactDir);

    const content = await fs.readFile(path.join(artifactDir, path.basename(reference.path)), 'utf-8');
    assert.match(content, /"\[REDACTED\]"/);
    assert.doesNotMatch(content, /should-not-persist/);
    assert.doesNotMatch(content, /bearer-secret-value|inline-secret|sk-1234567890abcdef/);
    assert.equal(reference.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(reference.chars, content.length);
});

test('writeRunArtifact stores the complete redacted query and final answer locally', async () => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-run-artifact-'));
    const reference = await writeRunArtifact({
        traceId: 'c'.repeat(32),
        instruction: '请检查 token=my-secret 的问题',
        finalAnswer: 'Authorization: Bearer answer-secret',
        model: 'test-model',
        buildId: 'build-1',
        terminationReason: 'completed',
        finalAnswerAction: 'allow',
        evidence: {
            state: 'sufficient',
            count: 2,
            distinctSources: 1,
            citedCount: 2
        }
    }, artifactDir);

    const content = await fs.readFile(path.join(artifactDir, path.basename(reference.path)), 'utf-8');
    assert.match(content, /请检查 token=\[REDACTED\] 的问题/);
    assert.doesNotMatch(content, /my-secret|answer-secret/);
    assert.equal(reference.sha256, createHash('sha256').update(content).digest('hex'));
});
