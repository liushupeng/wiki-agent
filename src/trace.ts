import fs from 'fs/promises';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

export type TerminationReason = 'completed' | 'max_loop_steps' | 'system_error';

type TraceEventBase = {
    at: string;
};

export type TraceEvent =
    (TraceEventBase & { type: 'span_start'; schemaVersion: 2; traceId: string; spanId: string; parentSpanId?: string; name: string; kind: string; startedAt: string; attributes: TraceAttributes })
    | (TraceEventBase & { type: 'span_end'; schemaVersion: 2; traceId: string; spanId: string; endedAt: string; status: TraceSpanStatus; attributes?: TraceAttributes })
    | (TraceEventBase & { type: 'span_event'; schemaVersion: 2; traceId: string; spanId: string; name: string; attributes: TraceAttributes });

export interface TraceSink {
    readonly filePath?: string;
    write(event: TraceEvent): Promise<void>;
}

export class NoopTraceSink implements TraceSink {
    async write(_event: TraceEvent): Promise<void> {}
}

export class JsonlTraceSink implements TraceSink {
    readonly filePath: string;

    constructor(traceDir = 'var/traces') {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.resolve(traceDir, `trace-${safeTimestamp}.jsonl`);
    }

    async write(event: TraceEvent): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    }
}

export class TraceLogger {
    readonly filePath: string;
    private readonly sink: TraceSink;

    constructor(traceDirOrSink: string | TraceSink = 'var/traces') {
        this.sink = typeof traceDirOrSink === 'string'
            ? new JsonlTraceSink(traceDirOrSink)
            : traceDirOrSink;
        this.filePath = this.sink.filePath ?? '';
    }

    async write(event: TraceEvent): Promise<void> {
        await this.sink.write(event);
    }
}

export type TraceAttributeValue = string | number | boolean;
export type TraceAttributes = Record<string, TraceAttributeValue>;
export type TraceSpanStatus = 'ok' | 'error' | 'unset';

export type TraceContext = {
    traceId: string;
    spanId: string;
};

export type StartSpanOptions = {
    kind?: string;
    attributes?: TraceAttributes;
    startedAt?: Date;
};

export interface SpanHandle {
    readonly context: TraceContext;
    readonly name: string;
    startChild(name: string, options?: StartSpanOptions): Promise<SpanHandle>;
    addEvent(name: string, attributes?: TraceAttributes, at?: Date): Promise<void>;
    end(options?: { status?: TraceSpanStatus; attributes?: TraceAttributes; endedAt?: Date }): Promise<void>;
}

export interface Telemetry {
    startSpan(name: string, options?: StartSpanOptions): Promise<SpanHandle>;
    shutdown(): Promise<void>;
}

export type TelemetryBackend = 'file' | 'otlp';
export type OtlpProtocol = 'http' | 'grpc';

const activeSpanStorage = new AsyncLocalStorage<SpanHandle>();

export function getActiveSpan(): SpanHandle | undefined {
    return activeSpanStorage.getStore();
}

export async function runWithSpan<T>(span: SpanHandle, operation: () => Promise<T>): Promise<T> {
    return activeSpanStorage.run(span, operation);
}

export function createTelemetry(options: {
    backend?: TelemetryBackend;
    traceDir?: string;
    otlpEndpoint?: string;
    otlpProtocol?: OtlpProtocol;
    serviceName?: string;
    fileLogger?: TraceLogger;
} = {}): Telemetry {
    if ((options.backend ?? 'file') === 'otlp') {
        if (!options.otlpEndpoint) {
            throw new Error('OTLP telemetry requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
        }
        return new OtelTelemetry(options.otlpEndpoint, options.otlpProtocol ?? 'http', options.serviceName ?? 'wiki-agent');
    }
    return new FileTelemetry(options.fileLogger ?? new TraceLogger(options.traceDir), options.serviceName ?? 'wiki-agent');
}

class FileTelemetry implements Telemetry {
    constructor(
        private readonly logger: TraceLogger,
        private readonly serviceName: string
    ) {}

    async startSpan(name: string, options: StartSpanOptions = {}): Promise<SpanHandle> {
        const startedAt = options.startedAt ?? new Date();
        const span = new FileSpan(this.logger, {
            traceId: createTraceId(),
            spanId: createSpanId(),
            name,
            kind: options.kind ?? 'internal',
            startedAt,
            attributes: { 'service.name': this.serviceName, ...(options.attributes ?? {}) }
        });
        await span.writeStart();
        return span;
    }

    async shutdown(): Promise<void> {}
}

class FileSpan implements SpanHandle {
    readonly context: TraceContext;
    private ended = false;

    constructor(
        private readonly logger: TraceLogger,
        private readonly input: {
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            name: string;
            kind: string;
            startedAt: Date;
            attributes: TraceAttributes;
        }
    ) {
        this.context = { traceId: input.traceId, spanId: input.spanId };
    }

    get name(): string {
        return this.input.name;
    }

    async writeStart(): Promise<void> {
        await this.logger.write({
            type: 'span_start',
            schemaVersion: 2,
            traceId: this.input.traceId,
            spanId: this.input.spanId,
            ...(this.input.parentSpanId ? { parentSpanId: this.input.parentSpanId } : {}),
            name: this.input.name,
            kind: this.input.kind,
            startedAt: this.input.startedAt.toISOString(),
            attributes: this.input.attributes,
            at: this.input.startedAt.toISOString()
        });
    }

    async startChild(name: string, options: StartSpanOptions = {}): Promise<SpanHandle> {
        const startedAt = options.startedAt ?? new Date();
        const child = new FileSpan(this.logger, {
            traceId: this.input.traceId,
            spanId: createSpanId(),
            parentSpanId: this.input.spanId,
            name,
            kind: options.kind ?? 'internal',
            startedAt,
            attributes: options.attributes ?? {}
        });
        await child.writeStart();
        return child;
    }

    async addEvent(name: string, attributes: TraceAttributes = {}, at = new Date()): Promise<void> {
        await this.logger.write({
            type: 'span_event',
            schemaVersion: 2,
            traceId: this.input.traceId,
            spanId: this.input.spanId,
            name,
            attributes,
            at: at.toISOString()
        });
    }

    async end(options: { status?: TraceSpanStatus; attributes?: TraceAttributes; endedAt?: Date } = {}): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        const endedAt = options.endedAt ?? new Date();
        await this.logger.write({
            type: 'span_end',
            schemaVersion: 2,
            traceId: this.input.traceId,
            spanId: this.input.spanId,
            endedAt: endedAt.toISOString(),
            status: options.status ?? 'unset',
            ...(options.attributes ? { attributes: options.attributes } : {}),
            at: endedAt.toISOString()
        });
    }
}

class OtelTelemetry implements Telemetry {
    private readonly provider: BasicTracerProvider;
    private readonly tracer: Tracer;

    constructor(endpoint: string, protocol: OtlpProtocol, serviceName: string) {
        const exporter = protocol === 'grpc'
            ? new OTLPGrpcTraceExporter({ url: endpoint })
            : new OTLPTraceExporter({ url: endpoint });
        this.provider = new BasicTracerProvider({
            resource: resourceFromAttributes({ 'service.name': serviceName }),
            spanProcessors: [new SimpleSpanProcessor(exporter)]
        });
        this.tracer = this.provider.getTracer('wiki-agent');
    }

    async startSpan(name: string, options: StartSpanOptions = {}): Promise<SpanHandle> {
        const parent = getActiveSpan();
        const parentContext = parent instanceof OtelSpan
            ? trace.setSpan(context.active(), parent.span)
            : context.active();
        return new OtelSpan(this.tracer, this.tracer.startSpan(name, {
            startTime: options.startedAt?.getTime(),
            attributes: options.attributes
        }, parentContext), name);
    }

    async shutdown(): Promise<void> {
        await this.provider.shutdown();
    }
}

class OtelSpan implements SpanHandle {
    readonly context: TraceContext;

    constructor(
        private readonly tracer: Tracer,
        readonly span: Span,
        readonly name: string
    ) {
        const spanContext = span.spanContext();
        this.context = { traceId: spanContext.traceId, spanId: spanContext.spanId };
    }

    async startChild(name: string, options: StartSpanOptions = {}): Promise<SpanHandle> {
        const parentContext = trace.setSpan(context.active(), this.span);
        const child = new OtelSpan(this.tracer, this.tracer.startSpan(name, {
            startTime: options.startedAt?.getTime(),
            attributes: options.attributes
        }, parentContext), name);
        return child;
    }

    async addEvent(name: string, attributes: TraceAttributes = {}, at = new Date()): Promise<void> {
        this.span.addEvent(name, attributes, at.getTime());
    }

    async end(options: { status?: TraceSpanStatus; attributes?: TraceAttributes; endedAt?: Date } = {}): Promise<void> {
        if (options.attributes) this.span.setAttributes(options.attributes);
        this.span.setStatus({ code: options.status === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
        this.span.end(options.endedAt?.getTime());
    }
}

function createTraceId(): string {
    return randomUUID().replace(/-/g, '');
}

function createSpanId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * 生成写入 trace 的短文本摘要。
 *
 * Trace 只需要帮助复盘关键内容，不应该把完整回答、工具结果或大段 diff 全量写入。
 * 这里会先把连续空白压成单个空格，再按 maxLength 截断并追加省略号。
 */
export function preview(value: string, maxLength = 600): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
