import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpanKind } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { exportTrace } from '../trace/export.js';

test('exportTrace exports version 2 spans without network output by default', async () => {
    await withTrace(version2Trace(), async inputPath => {
        const report = await exportTrace({ inputPath });

        assert.equal(report.inputPath, inputPath);
        assert.equal(report.mode, 'dry-run');
        assert.equal(report.runCount, 1);
        assert.equal(report.rootSpanCount, 1);
        assert.equal(report.spanCount, 2);
        assert.equal(report.eventCount, 1);
        assert.equal(report.skippedEventCount, 0);
        assert.deepEqual(report.traceIds, ['a'.repeat(32)]);
    });
});

test('exportTrace preserves JSONL trace, span, parent, and kind identities', async () => {
    await withTrace(version2Trace(), async inputPath => {
        const exporter = new RetainingSpanExporter();
        await exportTrace({ inputPath, spanExporter: exporter });

        const spans = exporter.spans;
        const root = spans.find(span => span.name === 'wiki_agent.run');
        const child = spans.find(span => span.name === 'tool.execute');

        assert.equal(root?.spanContext().traceId, 'a'.repeat(32));
        assert.equal(root?.spanContext().spanId, 'b'.repeat(16));
        assert.equal(root?.parentSpanContext, undefined);
        assert.equal(child?.spanContext().traceId, 'a'.repeat(32));
        assert.equal(child?.spanContext().spanId, 'c'.repeat(16));
        assert.equal(child?.parentSpanContext?.spanId, 'b'.repeat(16));
        assert.equal(child?.kind, SpanKind.CLIENT);
        assert.equal(exporter.exportCallCount, 1);
    });
});

class RetainingSpanExporter implements SpanExporter {
    readonly spans: ReadableSpan[] = [];
    exportCallCount = 0;

    export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode }) => void): void {
        this.exportCallCount += 1;
        this.spans.push(...spans);
        resultCallback({ code: ExportResultCode.SUCCESS });
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

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
            kind: 'client',
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
