import fs from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { SpanExporter } from '@opentelemetry/sdk-trace';

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
    timeoutMillis?: number;
    spanExporter?: SpanExporter;
};

export type TraceExportReport = {
    inputPath: string;
    mode: 'dry-run' | 'exported';
    runCount: number;
    spanCount: number;
    eventCount: number;
    skippedEventCount: number;
    traceIds: string[];
};

export async function exportTrace(options: TraceExportOptions): Promise<TraceExportReport> {
    const inputPath = path.resolve(options.inputPath);
    const identities = await collectSpanIdentities(inputPath);
    const exporter = options.spanExporter
        ?? (options.endpoint
            ? new OTLPTraceExporter({ url: options.endpoint, timeoutMillis: options.timeoutMillis })
            : new InMemorySpanExporter());
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'wiki-agent' }),
        idGenerator: new ReplayIdGenerator(identities),
        // Replay can end many historical spans synchronously. Batch them so the
        // OTLP HTTP exporter's per-request concurrency limit cannot drop late
        // spans, including the root span that typically ends last.
        spanProcessors: [new BatchSpanProcessor(exporter, {
            maxQueueSize: 2048,
            maxExportBatchSize: 512,
            scheduledDelayMillis: 60_000
        })]
    });
    const report: TraceExportReport = {
        inputPath,
        mode: options.endpoint ? 'exported' : 'dry-run',
        runCount: 0,
        spanCount: 0,
        eventCount: 0,
        skippedEventCount: 0,
        traceIds: []
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
            if (parentSpanId && !parent) {
                throw new Error(`missing parent span ${parentSpanId} for ${record.traceId}:${record.spanId}`);
            }
            const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
            const span = tracer.startSpan(stringValue(record.name), {
                startTime: toTimestamp(stringValue(record.startedAt) || record.at),
                kind: toSpanKind(stringValue(record.kind)),
                attributes: attributesOf(record.attributes)
            }, parentContext);
            const spanContext = span.spanContext();
            if (spanContext.traceId !== record.traceId || spanContext.spanId !== record.spanId) {
                throw new Error(`failed to preserve OTLP identity for ${record.traceId}:${record.spanId}`);
            }
            if (!report.traceIds.includes(record.traceId)) report.traceIds.push(record.traceId);
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

type SpanIdentity = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
};

class ReplayIdGenerator {
    private readonly rootTraceIds: string[];
    private readonly spanIds: string[];

    constructor(identities: SpanIdentity[]) {
        this.rootTraceIds = identities.filter(identity => !identity.parentSpanId).map(identity => identity.traceId);
        this.spanIds = identities.map(identity => identity.spanId);
    }

    generateTraceId(): string {
        const traceId = this.rootTraceIds.shift();
        if (!traceId) throw new Error('trace export requested an unexpected trace ID');
        return traceId;
    }

    generateSpanId(): string {
        const spanId = this.spanIds.shift();
        if (!spanId) throw new Error('trace export requested an unexpected span ID');
        return spanId;
    }
}

async function collectSpanIdentities(inputPath: string): Promise<SpanIdentity[]> {
    const identities: SpanIdentity[] = [];
    for await (const record of readSpanRecords(inputPath)) {
        if (record.type !== 'span_start') continue;
        if (!isTraceId(record.traceId) || !isSpanId(record.spanId) || (typeof record.parentSpanId === 'string' && !isSpanId(record.parentSpanId))) {
            throw new Error(`invalid OTLP identity in ${inputPath}: ${record.traceId}:${record.spanId}`);
        }
        identities.push({
            traceId: record.traceId,
            spanId: record.spanId,
            ...(typeof record.parentSpanId === 'string' ? { parentSpanId: record.parentSpanId } : {})
        });
    }
    return identities;
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

function toSpanKind(kind: string): SpanKind {
    if (kind === 'client') return SpanKind.CLIENT;
    if (kind === 'server') return SpanKind.SERVER;
    if (kind === 'producer') return SpanKind.PRODUCER;
    if (kind === 'consumer') return SpanKind.CONSUMER;
    return SpanKind.INTERNAL;
}

function isTraceId(value: string): boolean {
    return /^[a-f0-9]{32}$/.test(value) && !/^0{32}$/.test(value);
}

function isSpanId(value: string): boolean {
    return /^[a-f0-9]{16}$/.test(value) && !/^0{16}$/.test(value);
}
