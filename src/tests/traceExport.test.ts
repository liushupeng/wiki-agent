import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportTrace } from '../trace/export.js';

test('exportTrace exports version 2 spans without network output by default', async () => {
    await withTrace(version2Trace(), async inputPath => {
        const report = await exportTrace({ inputPath });

        assert.deepEqual(report, {
            inputPath,
            mode: 'dry-run',
            runCount: 1,
            spanCount: 2,
            eventCount: 1,
            skippedEventCount: 0
        });
    });
});

test('exportTrace rejects traces that do not use the current schema', async () => {
    await withTrace([{ type: 'run_start', at: '2026-01-01T00:00:00.000Z' }], async inputPath => {
        await assert.rejects(
            () => exportTrace({ inputPath }),
            new RegExp(`unsupported trace schema at ${escapeRegex(inputPath)}:1`)
        );
    });
});

function version2Trace(): unknown[] {
    const traceId = 'a'.repeat(32);
    const runSpanId = 'b'.repeat(16);
    const toolSpanId = 'c'.repeat(16);
    return [
        {
            type: 'span_start',
            schemaVersion: 2,
            traceId,
            spanId: runSpanId,
            name: 'wiki_agent.run',
            kind: 'internal',
            startedAt: '2026-01-01T00:00:00.000Z',
            attributes: {},
            at: '2026-01-01T00:00:00.000Z'
        },
        {
            type: 'span_start',
            schemaVersion: 2,
            traceId,
            spanId: toolSpanId,
            parentSpanId: runSpanId,
            name: 'tool.execute',
            kind: 'internal',
            startedAt: '2026-01-01T00:00:01.000Z',
            attributes: { 'tool.name': 'search_notes' },
            at: '2026-01-01T00:00:01.000Z'
        },
        {
            type: 'span_event',
            schemaVersion: 2,
            traceId,
            spanId: toolSpanId,
            name: 'tool.permission_decision',
            attributes: { 'tool.permission.action': 'allow' },
            at: '2026-01-01T00:00:01.500Z'
        },
        {
            type: 'span_end',
            schemaVersion: 2,
            traceId,
            spanId: toolSpanId,
            endedAt: '2026-01-01T00:00:02.000Z',
            status: 'ok',
            at: '2026-01-01T00:00:02.000Z'
        },
        {
            type: 'span_end',
            schemaVersion: 2,
            traceId,
            spanId: runSpanId,
            endedAt: '2026-01-01T00:00:03.000Z',
            status: 'ok',
            at: '2026-01-01T00:00:03.000Z'
        }
    ];
}

async function withTrace(records: unknown[], run: (inputPath: string) => Promise<void>): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-trace-export-'));
    const inputPath = path.join(directory, 'trace.jsonl');
    await fs.writeFile(inputPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
    try {
        await run(inputPath);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
