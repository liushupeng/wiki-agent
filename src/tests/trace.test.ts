import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getTraceLevelFromEnv, preview, shouldWriteTraceLevel, TraceLogger } from '../trace.js';

test('TraceLogger creates a JSONL file path inside the trace directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-'));
    const logger = new TraceLogger(tempDir);

    assert.equal(path.dirname(logger.filePath), path.resolve(tempDir));
    assert.match(path.basename(logger.filePath), /^trace-\d{4}-\d{2}-\d{2}T.*Z\.jsonl$/);
});

test('TraceLogger appends events as JSON lines', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-'));
    const logger = new TraceLogger(tempDir);

    await logger.write({ type: 'run_start', instruction: 'hello', at: '2026-01-01T00:00:00.000Z' });
    await logger.write({ type: 'step_start', step: 1, at: '2026-01-01T00:00:01.000Z' });

    const lines = (await fs.readFile(logger.filePath, 'utf-8')).trim().split('\n');

    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), {
        level: 'info',
        type: 'run_start',
        instruction: 'hello',
        at: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(JSON.parse(lines[1]), {
        level: 'info',
        type: 'step_start',
        step: 1,
        at: '2026-01-01T00:00:01.000Z'
    });
});

test('TraceLogger filters events below the configured level', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-'));
    const logger = new TraceLogger(tempDir, 'info');

    await logger.write({
        type: 'model_call_budget',
        step: 1,
        inputMessageCount: 2,
        input: { chars: 100, approxTokens: 25 },
        toolSchemaCount: 3,
        toolSchemas: { chars: 80, approxTokens: 20 },
        output: { chars: 20, approxTokens: 5 },
        toolCallCount: 1,
        at: '2026-01-01T00:00:00.000Z'
    });
    await logger.write({
        type: 'permission_decision',
        level: 'debug',
        toolName: 'write_file',
        action: 'ask',
        reason: 'approval required',
        riskLevel: 'write',
        at: '2026-01-01T00:00:00.000Z'
    });
    await logger.write({ type: 'step_start', step: 1, at: '2026-01-01T00:00:01.000Z' });

    const lines = (await fs.readFile(logger.filePath, 'utf-8')).trim().split('\n');

    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).type, 'step_start');
});

test('Trace level helpers parse and compare levels', () => {
    assert.equal(getTraceLevelFromEnv({ TRACE_LEVEL: 'debug' }), 'debug');
    assert.equal(getTraceLevelFromEnv({ TRACE_LEVEL: 'invalid' }), 'info');
    assert.equal(shouldWriteTraceLevel('debug', 'info'), false);
    assert.equal(shouldWriteTraceLevel('error', 'info'), true);
});

test('preview normalizes whitespace and truncates long text', () => {
    const result = preview('  a\n\tb   cdef  ', 5);

    assert.equal(result, 'a b c...');
});
