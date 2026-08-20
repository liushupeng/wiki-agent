import fs from 'node:fs/promises';
import path from 'node:path';
import '../../src/env.js';
import { parseJsonc } from '../../src/utils/jsonc.js';

type TraceLine = {
    type?: string;
    traceId?: string;
    spanId?: string;
    name?: string;
    startedAt?: string;
    endedAt?: string;
    status?: string;
    attributes?: Record<string, unknown>;
};

type RunSample = {
    traceId: string;
    startedAt: string;
    durationMs: number;
    completed: boolean;
    toolCalls: number;
    toolFailures: number;
    ragCalls: number;
    ragCacheHits: number;
    ragBudgetExhausted: boolean;
    totalTokens: number;
};

type OperationsSlo = {
    minimumSampleRuns: number;
    completionRateMin: number;
    p95LatencyMsMax: number;
    toolFailureRateMax: number;
    ragRetrieverCacheHitRateMin: number;
    ragBudgetExhaustionRateMax: number;
    averageTotalTokensMax: number;
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const files = await listJsonlFiles(options.directory);
    const cutoff = Date.now() - options.sinceHours * 60 * 60 * 1000;
    const samples = (await Promise.all(files.map(file => readRun(file))))
        .filter((sample): sample is RunSample => Boolean(sample))
        .filter(sample => sample.durationMs >= 0)
        .filter(sample => Date.parse(sample.startedAt) >= cutoff);

    const durations = samples.map(sample => sample.durationMs);
    const toolCalls = samples.reduce((sum, sample) => sum + sample.toolCalls, 0);
    const ragCalls = samples.reduce((sum, sample) => sum + sample.ragCalls, 0);
    const completed = samples.filter(sample => sample.completed).length;
    const sli = {
        completionRate: ratio(completed, samples.length),
        latencyMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
        toolFailureRate: ratio(samples.reduce((sum, sample) => sum + sample.toolFailures, 0), toolCalls),
        ragRetrieverCacheHitRate: ratio(samples.reduce((sum, sample) => sum + sample.ragCacheHits, 0), ragCalls),
        ragBudgetExhaustionRate: ratio(samples.filter(sample => sample.ragBudgetExhausted).length, samples.length),
        averageTotalTokens: samples.length
            ? Math.round(samples.reduce((sum, sample) => sum + sample.totalTokens, 0) / samples.length)
            : null
    };
    const slo = await loadSlo();
    const checks = {
        completionRate: atLeast(sli.completionRate, slo.completionRateMin),
        p95LatencyMs: atMost(sli.latencyMs.p95, slo.p95LatencyMsMax),
        toolFailureRate: atMost(sli.toolFailureRate, slo.toolFailureRateMax),
        ragRetrieverCacheHitRate: atLeast(sli.ragRetrieverCacheHitRate, slo.ragRetrieverCacheHitRateMin),
        ragBudgetExhaustionRate: atMost(sli.ragBudgetExhaustionRate, slo.ragBudgetExhaustionRateMax),
        averageTotalTokens: atMost(sli.averageTotalTokens, slo.averageTotalTokensMax)
    };
    const enoughSamples = samples.length >= slo.minimumSampleRuns;
    console.log(JSON.stringify({
        windowHours: options.sinceHours,
        traceDirectory: options.directory,
        runs: samples.length,
        sli,
        slo: {
            thresholds: slo,
            enoughSamples,
            checks,
            healthy: enoughSamples && Object.values(checks).every(result => result !== false)
        }
    }, null, 2));
}

async function loadSlo(): Promise<OperationsSlo> {
    const sloPath = path.resolve(process.env.OPERATIONS_SLO_PATH ?? 'config/operations.slo.jsonc');
    return parseJsonc(await fs.readFile(sloPath, 'utf-8'), `operations SLO "${sloPath}"`) as OperationsSlo;
}

async function readRun(file: string): Promise<RunSample | undefined> {
    const lines = (await fs.readFile(file, 'utf-8')).split(/\r?\n/).filter(Boolean);
    const starts = new Map<string, TraceLine>();
    let rootStart: TraceLine | undefined;
    let rootEnd: TraceLine | undefined;
    let toolCalls = 0;
    let toolFailures = 0;
    let ragCalls = 0;
    let ragCacheHits = 0;
    let totalTokens = 0;
    for (const line of lines) {
        let event: TraceLine;
        try {
            event = JSON.parse(line) as TraceLine;
        } catch {
            continue;
        }
        if (event.type === 'span_start' && event.spanId) {
            starts.set(event.spanId, event);
            if (event.name === 'wiki_agent.run') rootStart = event;
            if (event.name === 'tool.execute') toolCalls += 1;
            if (event.name === 'rag.search') ragCalls += 1;
            continue;
        }
        if (
            event.type === 'span_event'
            && event.spanId
            && starts.get(event.spanId)?.name === 'rag.search'
            && event.attributes?.['wiki_agent.rag.retriever_cache_hit'] === true
        ) {
            ragCacheHits += 1;
            continue;
        }
        if (event.type !== 'span_end' || !event.spanId) continue;
        const start = starts.get(event.spanId);
        if (start?.name === 'wiki_agent.run') rootEnd = event;
        if (start?.name === 'tool.execute' && event.status !== 'ok') toolFailures += 1;
        if (start?.name === 'gen_ai.chat') {
            totalTokens += asNumber(event.attributes?.['gen_ai.usage.total_tokens']);
        }
    }
    if (!rootStart?.traceId || !rootStart.startedAt || !rootEnd?.endedAt) return undefined;
    return {
        traceId: rootStart.traceId,
        startedAt: rootStart.startedAt,
        durationMs: Date.parse(rootEnd.endedAt) - Date.parse(rootStart.startedAt),
        completed: rootEnd.attributes?.['wiki_agent.termination_reason'] === 'completed' || rootEnd.status === 'ok',
        toolCalls,
        toolFailures,
        ragCalls,
        ragCacheHits,
        ragBudgetExhausted: rootEnd.attributes?.['wiki_agent.rag.budget_exhausted'] === true,
        totalTokens
    };
}

async function listJsonlFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map(entry => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory()
            ? listJsonlFiles(fullPath)
            : Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [fullPath] : []);
    }));
    return nested.flat();
}

function parseArgs(args: string[]): { directory: string; sinceHours: number } {
    let directory = path.resolve(process.env.TRACE_DIR ?? 'var/traces');
    let sinceHours = 24;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--dir') directory = path.resolve(args[++index] ?? '');
        else if (args[index] === '--since-hours') sinceHours = Number(args[++index]);
    }
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new Error('--since-hours must be positive');
    return { directory, sinceHours };
}

function percentile(values: number[], quantile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return Math.round(sorted[Math.ceil(quantile * sorted.length) - 1]!);
}

function ratio(numerator: number, denominator: number): number | null {
    return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function asNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function atLeast(actual: number | null, expected: number): boolean | null {
    return actual === null ? null : actual >= expected;
}

function atMost(actual: number | null, expected: number): boolean | null {
    return actual === null ? null : actual <= expected;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
