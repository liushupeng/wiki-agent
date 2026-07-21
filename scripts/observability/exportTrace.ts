import fs from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';

type TraceRecord = Record<string, unknown> & {
    type: string;
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

type ActiveRun = {
    span: ReturnType<ReturnType<BasicTracerProvider['getTracer']>['startSpan']>;
    step?: {
        number: number;
        span: ReturnType<ReturnType<BasicTracerProvider['getTracer']>['startSpan']>;
    };
};

export async function exportTrace(options: TraceExportOptions): Promise<TraceExportReport> {
    const exporter: SpanExporter = options.endpoint
        ? new OTLPTraceExporter({ url: options.endpoint })
        : new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
            'service.name': options.serviceName ?? 'wiki-agent',
            'telemetry.sdk.language': 'nodejs'
        }),
        spanProcessors: [new SimpleSpanProcessor(exporter)]
    });
    const tracer = provider.getTracer('wiki-agent.trace-exporter');
    const report: TraceExportReport = {
        inputPath: path.resolve(options.inputPath),
        mode: options.endpoint ? 'exported' : 'dry-run',
        runCount: 0,
        spanCount: 0,
        eventCount: 0,
        skippedEventCount: 0
    };
    let activeRun: ActiveRun | undefined;

    try {
        for await (const record of readTraceRecords(report.inputPath)) {
            const timestamp = toTimestamp(record.at);

            if (record.type === 'run_start') {
                if (activeRun) {
                    closeRun(activeRun, timestamp, 'incomplete');
                }
                const span = tracer.startSpan('wiki_agent.run', {
                    startTime: timestamp,
                    attributes: {
                        'wiki_agent.instruction': shortString(record.instruction)
                    }
                });
                activeRun = { span };
                report.runCount += 1;
                report.spanCount += 1;
                continue;
            }

            if (!activeRun) {
                report.skippedEventCount += 1;
                continue;
            }

            const parentContext = trace.setSpan(context.active(), activeRun.span);
            switch (record.type) {
                case 'step_start': {
                    if (activeRun.step) activeRun.step.span.end(timestamp);
                    const stepNumber = numberValue(record.step);
                    activeRun.step = {
                        number: stepNumber,
                        span: tracer.startSpan('wiki_agent.step', {
                            startTime: timestamp,
                            attributes: { 'wiki_agent.step': stepNumber }
                        }, parentContext)
                    };
                    report.spanCount += 1;
                    break;
                }
                case 'model_call_budget':
                    createInstantSpan(tracer, 'gen_ai.chat', timestamp, parentContext, {
                        'wiki_agent.step': numberValue(record.step),
                        'gen_ai.operation.name': 'chat',
                        'gen_ai.usage.input_tokens': nestedNumber(record, 'input', 'approxTokens'),
                        'gen_ai.usage.output_tokens': nestedNumber(record, 'output', 'approxTokens'),
                        'gen_ai.usage.total_tokens': nestedNumber(record, 'usage', 'totalTokens'),
                        'wiki_agent.tool_call_count': numberValue(record.toolCallCount)
                    });
                    report.spanCount += 1;
                    break;
                case 'tool_result':
                    createTimedSpan(tracer, 'tool.execute', timestamp, numberValue(record.durationMs), parentContext, {
                        'wiki_agent.step': numberValue(record.step),
                        'tool.name': shortString(record.toolName),
                        'tool.status': shortString(record.status),
                        'wiki_agent.observation.chars': nestedNumber(record, 'observation', 'chars'),
                        'wiki_agent.result.truncated': booleanValue(record.truncated)
                    });
                    report.spanCount += 1;
                    break;
                case 'rag_search':
                    createInstantSpan(tracer, 'rag.search', timestamp, parentContext, {
                        'wiki_agent.tool.name': shortString(record.toolName),
                        'wiki_agent.rag.query': shortString(record.query),
                        'wiki_agent.rag.match_count': numberValue(record.matchCount),
                        'wiki_agent.rag.top_k': numberValue(record.topK)
                    });
                    report.spanCount += 1;
                    break;
                case 'assistant_message':
                case 'permission_decision':
                case 'memory_compaction':
                    activeRun.span.addEvent(record.type, toAttributes(record), timestamp);
                    report.eventCount += 1;
                    break;
                case 'run_end':
                    closeRun(activeRun, timestamp, shortString(record.terminationReason));
                    activeRun = undefined;
                    break;
                default:
                    report.skippedEventCount += 1;
            }
        }

        if (activeRun) closeRun(activeRun, Date.now(), 'incomplete');
        await provider.forceFlush();
        return report;
    } finally {
        await provider.shutdown();
    }
}

function createInstantSpan(
    tracer: ReturnType<BasicTracerProvider['getTracer']>,
    name: string,
    timestamp: number,
    parentContext: ReturnType<typeof context.active>,
    attributes: Record<string, string | number | boolean | undefined>
): void {
    const span = tracer.startSpan(name, { startTime: timestamp, attributes: withoutUndefined(attributes) }, parentContext);
    span.end(timestamp);
}

function createTimedSpan(
    tracer: ReturnType<BasicTracerProvider['getTracer']>,
    name: string,
    endTimestamp: number,
    durationMs: number,
    parentContext: ReturnType<typeof context.active>,
    attributes: Record<string, string | number | boolean | undefined>
): void {
    const startTimestamp = Math.max(0, endTimestamp - Math.max(0, durationMs));
    const span = tracer.startSpan(name, { startTime: startTimestamp, attributes: withoutUndefined(attributes) }, parentContext);
    span.setStatus({ code: attributes['tool.status'] === 'success' ? SpanStatusCode.UNSET : SpanStatusCode.ERROR });
    span.end(endTimestamp);
}

function closeRun(activeRun: ActiveRun, timestamp: number, terminationReason: string): void {
    activeRun.step?.span.end(timestamp);
    activeRun.span.setAttribute('wiki_agent.termination_reason', terminationReason);
    activeRun.span.setStatus({
        code: terminationReason === 'completed' ? SpanStatusCode.UNSET : SpanStatusCode.ERROR
    });
    activeRun.span.end(timestamp);
}

async function* readTraceRecords(inputPath: string): AsyncGenerator<TraceRecord> {
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
        if (!isTraceRecord(value)) {
            throw new Error(`invalid trace event at ${inputPath}:${lineNumber}: expected "type" and "at" strings`);
        }
        yield value;
    }
}

function isTraceRecord(value: unknown): value is TraceRecord {
    return typeof value === 'object'
        && value !== null
        && typeof (value as Record<string, unknown>).type === 'string'
        && typeof (value as Record<string, unknown>).at === 'string';
}

function toTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new Error(`invalid trace timestamp: ${value}`);
    return timestamp;
}

function toAttributes(record: TraceRecord): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record)) {
        if (key === 'type' || key === 'at') continue;
        if (typeof value === 'string') attributes[`wiki_agent.${key}`] = shortString(value);
        if (typeof value === 'number' || typeof value === 'boolean') attributes[`wiki_agent.${key}`] = value;
    }
    return attributes;
}

function withoutUndefined<T extends Record<string, string | number | boolean | undefined>>(value: T): Record<string, string | number | boolean> {
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined));
}

function shortString(value: unknown, maxLength = 512): string {
    if (typeof value !== 'string') return '';
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function numberValue(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
    return value === true;
}

function nestedNumber(record: TraceRecord, objectKey: string, valueKey: string): number {
    const nested = record[objectKey];
    return typeof nested === 'object' && nested !== null
        ? numberValue((nested as Record<string, unknown>)[valueKey])
        : 0;
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

    if (!inputPath) {
        throw new Error('usage: npm run trace:export -- --input <trace.jsonl> [--endpoint <OTLP HTTP traces URL>] [--service-name <name>]');
    }
    return { inputPath, endpoint, serviceName };
}

async function main(): Promise<void> {
    const report = await exportTrace(parseArgs(process.argv.slice(2)));
    const message = report.mode === 'exported'
        ? `已导出 ${report.spanCount} 个 span 至 OTLP 后端。`
        : `Dry run 完成：未发送任何网络请求。`;
    console.log(`${message}\n运行=${report.runCount}，事件=${report.eventCount}，跳过=${report.skippedEventCount}，文件=${report.inputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Trace 导出失败: ${error.message}`);
        process.exitCode = 1;
    });
}
