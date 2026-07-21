import fs from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

type AttributeValue = string | number | boolean;
type SpanRecord = Record<string, unknown> & {
    type: 'span_start' | 'span_end' | 'span_event';
    schemaVersion: 2;
    traceId: string;
    spanId: string;
    at: string;
};

export type TraceExportOptions = {
    inputPath: string;
    endpoint?: string;
    serviceName?: string;
};

export type TraceExportReport = {
    inputPath: string;
    mode: 'dry-run' | 'exported';
    runCount: number;
    spanCount: number;
    eventCount: number;
    skippedEventCount: number;
};

export async function exportTrace(options: TraceExportOptions): Promise<TraceExportReport> {
    const exporter = options.endpoint
        ? new OTLPTraceExporter({ url: options.endpoint })
        : new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'wiki-agent' }),
        spanProcessors: [new SimpleSpanProcessor(exporter)]
    });
    const report: TraceExportReport = {
        inputPath: path.resolve(options.inputPath),
        mode: options.endpoint ? 'exported' : 'dry-run',
        runCount: 0,
        spanCount: 0,
        eventCount: 0,
        skippedEventCount: 0
    };

    try {
        await exportSpans(report.inputPath, provider.getTracer('wiki-agent.trace-exporter'), report);
        await provider.forceFlush();
        return report;
    } finally {
        await provider.shutdown();
    }
}

async function exportSpans(inputPath: string, tracer: Tracer, report: TraceExportReport): Promise<void> {
    const spans = new Map<string, Span>();
    let recordCount = 0;

    for await (const record of readSpanRecords(inputPath)) {
        recordCount += 1;
        const key = `${record.traceId}:${record.spanId}`;

        if (record.type === 'span_start') {
            const parentSpanId = stringValue(record.parentSpanId);
            const parent = parentSpanId ? spans.get(`${record.traceId}:${parentSpanId}`) : undefined;
            const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
            const span = tracer.startSpan(stringValue(record.name), {
                startTime: toTimestamp(stringValue(record.startedAt) || record.at),
                attributes: attributesOf(record.attributes)
            }, parentContext);
            spans.set(key, span);
            report.spanCount += 1;
            if (record.name === 'wiki_agent.run') report.runCount += 1;
            continue;
        }

        const span = spans.get(key);
        if (!span) {
            report.skippedEventCount += 1;
            continue;
        }
        if (record.type === 'span_event') {
            span.addEvent(stringValue(record.name), attributesOf(record.attributes), toTimestamp(record.at));
            report.eventCount += 1;
            continue;
        }

        span.setAttributes(attributesOf(record.attributes));
        span.setStatus({ code: stringValue(record.status) === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
        span.end(toTimestamp(stringValue(record.endedAt) || record.at));
        spans.delete(key);
    }

    if (recordCount === 0) throw new Error(`empty trace file: ${inputPath}`);
    for (const span of spans.values()) span.end();
}

async function* readSpanRecords(inputPath: string): AsyncGenerator<SpanRecord> {
    const input = fs.createReadStream(inputPath, 'utf-8');
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`invalid JSONL at ${inputPath}:${lineNumber}`);
        }
        if (!isSpanRecord(value)) {
            throw new Error(`unsupported trace schema at ${inputPath}:${lineNumber}: expected schemaVersion=2 span event`);
        }
        yield value;
    }
}

function isSpanRecord(value: unknown): value is SpanRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.schemaVersion === 2
        && (record.type === 'span_start' || record.type === 'span_end' || record.type === 'span_event')
        && typeof record.traceId === 'string'
        && typeof record.spanId === 'string'
        && typeof record.at === 'string';
}

function attributesOf(value: unknown): Record<string, AttributeValue> {
    if (!value || typeof value !== 'object') return {};
    const attributes: Record<string, AttributeValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') attributes[key] = item;
    }
    return attributes;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function toTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new Error(`invalid trace timestamp: ${value}`);
    return timestamp;
}

function parseArgs(args: string[]): TraceExportOptions {
    let inputPath: string | undefined;
    let endpoint: string | undefined;
    let serviceName: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === '--input') inputPath = args[++index];
        else if (value === '--endpoint') endpoint = args[++index];
        else if (value === '--service-name') serviceName = args[++index];
        else throw new Error(`unknown argument: ${value}`);
    }
    if (!inputPath) throw new Error('usage: npm run trace:export -- --input <trace.jsonl> [--endpoint <OTLP HTTP traces URL>] [--service-name <name>]');
    return { inputPath, endpoint, serviceName };
}

async function main(): Promise<void> {
    const report = await exportTrace(parseArgs(process.argv.slice(2)));
    const message = report.mode === 'exported' ? `已导出 ${report.spanCount} 个 span 至 OTLP 后端。` : 'Dry run 完成：未发送任何网络请求。';
    console.log(`${message}\n运行=${report.runCount}，事件=${report.eventCount}，跳过=${report.skippedEventCount}，文件=${report.inputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Trace 导出失败: ${error.message}`);
        process.exitCode = 1;
    });
}
