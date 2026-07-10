import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preview, TraceLogger } from '../trace.js';

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
        type: 'run_start',
        instruction: 'hello',
        at: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(JSON.parse(lines[1]), {
        type: 'step_start',
        step: 1,
        at: '2026-01-01T00:00:01.000Z'
    });
});

test('preview normalizes whitespace and truncates long text', () => {
    const result = preview('  a\n\tb   cdef  ', 5);

    assert.equal(result, 'a b c...');
});
