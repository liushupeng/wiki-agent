import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportTrace } from '../../scripts/observability/exportTrace.js';

test('exportTrace maps a completed run to OTLP spans without network output by default', async () => {
    await withTrace([
        { type: 'run_start', instruction: 'find dividend stocks', at: '2026-01-01T00:00:00.000Z' },
        { type: 'step_start', step: 1, at: '2026-01-01T00:00:01.000Z' },
        {
            type: 'model_call_budget',
            step: 1,
            input: { chars: 100, approxTokens: 25 },
            output: { chars: 20, approxTokens: 5 },
            toolCallCount: 1,
            at: '2026-01-01T00:00:02.000Z'
        },
        {
            type: 'tool_result',
            step: 1,
            toolName: 'search_notes',
            status: 'success',
            durationMs: 250,
            observation: { chars: 200, approxTokens: 50 },
            at: '2026-01-01T00:00:03.000Z'
        },
        {
            type: 'rag_search',
            toolName: 'search_notes',
            query: 'dividend',
            topK: 10,
            matchCount: 3,
            at: '2026-01-01T00:00:04.000Z'
        },
        { type: 'assistant_message', step: 1, contentPreview: 'done', toolCalls: [], at: '2026-01-01T00:00:05.000Z' },
        { type: 'run_end', finalOutputPreview: 'done', terminationReason: 'completed', at: '2026-01-01T00:00:06.000Z' }
    ], async inputPath => {
        const report = await exportTrace({ inputPath });

        assert.deepEqual(report, {
            inputPath,
            mode: 'dry-run',
            runCount: 1,
            spanCount: 5,
            eventCount: 1,
            skippedEventCount: 0
        });
    });
});

test('exportTrace reports malformed JSONL lines with their line number', async () => {
    await withRawTrace('{"type":"run_start","at":"2026-01-01T00:00:00.000Z"}\nnot-json\n', async inputPath => {
        await assert.rejects(
            () => exportTrace({ inputPath }),
            new RegExp(`invalid JSONL at ${escapeRegex(inputPath)}:2`)
        );
    });
});

async function withTrace(records: unknown[], run: (inputPath: string) => Promise<void>): Promise<void> {
    await withRawTrace(`${records.map(record => JSON.stringify(record)).join('\n')}\n`, run);
}

async function withRawTrace(content: string, run: (inputPath: string) => Promise<void>): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-export-'));
    const inputPath = path.join(directory, 'trace.jsonl');
    await fs.writeFile(inputPath, content, 'utf-8');
    try {
        await run(inputPath);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
