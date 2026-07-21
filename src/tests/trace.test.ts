import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTelemetry, preview } from '../trace.js';

test('file telemetry writes versioned spans with explicit parent-child identifiers', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-spans-'));
    const telemetry = createTelemetry({ traceDir: tempDir });
    const run = await telemetry.startSpan('wiki_agent.run');
    const step = await run.startChild('wiki_agent.step');
    const tool = await step.startChild('tool.execute');
    await tool.addEvent('tool.permission_decision', { 'tool.permission.action': 'allow' });
    await tool.end({ status: 'ok' });
    await step.end();
    await run.end({ status: 'ok' });

    const [fileName] = await fs.readdir(tempDir);
    const events = (await fs.readFile(path.join(tempDir, fileName!), 'utf-8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>);
    const starts = events.filter(event => event.type === 'span_start');
    const runStart = starts.find(event => event.name === 'wiki_agent.run');
    const stepStart = starts.find(event => event.name === 'wiki_agent.step');
    const toolStart = starts.find(event => event.name === 'tool.execute');

    assert.equal(runStart?.schemaVersion, 2);
    assert.equal(stepStart?.parentSpanId, runStart?.spanId);
    assert.equal(toolStart?.parentSpanId, stepStart?.spanId);
    assert.equal(events.filter(event => event.type === 'span_end').length, 3);
    assert.equal(events.find(event => event.type === 'span_event')?.name, 'tool.permission_decision');
});

test('preview normalizes whitespace and truncates long text', () => {
    assert.equal(preview('  a\n\tb   cdef  ', 5), 'a b c...');
});
