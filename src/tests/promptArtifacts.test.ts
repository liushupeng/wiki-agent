import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writePromptArtifact } from '../promptArtifacts.js';

test('writePromptArtifact redacts sensitive object fields and returns a verifiable reference', async () => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-prompt-artifact-'));
    const reference = await writePromptArtifact({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        model: 'test-model',
        temperature: 0,
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: 'hello', apiKey: 'should-not-persist' }],
        tools: []
    }, artifactDir);

    const content = await fs.readFile(path.join(artifactDir, path.basename(reference.path)), 'utf-8');
    assert.match(content, /"\[REDACTED\]"/);
    assert.doesNotMatch(content, /should-not-persist/);
    assert.equal(reference.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(reference.chars, content.length);
});
