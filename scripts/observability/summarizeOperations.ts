import fs from 'node:fs/promises';
import path from 'node:path';
import '../../src/env.js';
import { parseJsonc } from '../../src/utils/jsonc.js';
import { parseJsonlV2 } from '../../src/evaluation/trajectoryModel.js';
import {
    buildRunQualitySample,
    summarizeRunQuality,
    type RunQualitySample
} from '../../src/observability/runQuality.js';

type OperationsSlo = {
    minimumSampleRuns: number;
    minimumKnowledgeRuns: number;
    completionRateMin: number;
    p95LatencyMsMax: number;
    toolFailureRateMax: number;
    ragRetrieverCacheHitRateMin: number;
    ragBudgetExhaustionRateMax: number;
    averageTotalTokensMax: number;
    insufficientEvidenceRateMax: number;
    partialEvidenceRateMax: number;
    fallbackRateMax: number;
    emptyRetrievalRateMax: number;
    retrievalP95LatencyMsMax: number;
};

/**
 * Agent 运行与在线代理质量指标汇总。
 *
 * 只读取 file telemetry 的 JSONL；直接 OTLP 模式应在观测后端使用相同属性聚合。
 * evidence 指标只描述检索库存风险，不代表答案正确率。
 */
async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const files = await listJsonlFiles(options.directory);
    const cutoff = Date.now() - options.sinceHours * 60 * 60 * 1000;
    const samples = (await Promise.all(files.map(readRun)))
        .filter((sample): sample is RunQualitySample => Boolean(sample))
        .filter(sample => sample.durationMs >= 0)
        .filter(sample => Date.parse(sample.startedAt) >= cutoff);
    const summary = summarizeRunQuality(samples, options.maxCandidates);
    const slo = await loadSlo();
    const checks = {
        completionRate: atLeast(summary.sli.completionRate, slo.completionRateMin),
        p95LatencyMs: atMost(summary.sli.latencyMs.p95, slo.p95LatencyMsMax),
        toolFailureRate: atMost(summary.sli.toolFailureRate, slo.toolFailureRateMax),
        ragRetrieverCacheHitRate: atLeast(
            summary.sli.ragRetrieverCacheHitRate,
            slo.ragRetrieverCacheHitRateMin
        ),
        ragBudgetExhaustionRate: atMost(
            summary.sli.ragBudgetExhaustionRate,
            slo.ragBudgetExhaustionRateMax
        ),
        averageTotalTokens: atMost(summary.sli.averageTotalTokens, slo.averageTotalTokensMax),
        insufficientEvidenceRate: atMost(
            summary.sli.evidence.insufficientRate,
            slo.insufficientEvidenceRateMax
        ),
        partialEvidenceRate: atMost(summary.sli.evidence.partialRate, slo.partialEvidenceRateMax),
        fallbackRate: atMost(summary.sli.fallbackRate, slo.fallbackRateMax),
        emptyRetrievalRate: atMost(summary.sli.emptyRetrievalRate, slo.emptyRetrievalRateMax),
        retrievalP95LatencyMs: atMost(
            summary.sli.retrievalLatencyMs.p95,
            slo.retrievalP95LatencyMsMax
        )
    };
    const enoughSamples = summary.runs >= slo.minimumSampleRuns;
    const enoughKnowledgeRuns = summary.knowledgeRuns >= slo.minimumKnowledgeRuns;
    const operationalChecks = [
        checks.completionRate,
        checks.p95LatencyMs,
        checks.toolFailureRate,
        checks.ragBudgetExhaustionRate,
        checks.averageTotalTokens
    ];
    const knowledgeChecks = [
        checks.ragRetrieverCacheHitRate,
        checks.insufficientEvidenceRate,
        checks.partialEvidenceRate,
        checks.fallbackRate,
        checks.emptyRetrievalRate,
        checks.retrievalP95LatencyMs
    ];
    const healthy = enoughSamples
        && operationalChecks.every(result => result !== false)
        && (!enoughKnowledgeRuns || knowledgeChecks.every(result => result !== false));
    console.log(JSON.stringify({
        windowHours: options.sinceHours,
        traceDirectory: options.directory,
        backend: 'file-jsonl',
        ...summary,
        slo: {
            thresholds: slo,
            enoughSamples,
            enoughKnowledgeRuns,
            checks,
            healthy
        }
    }, null, 2));
    if (options.failOnUnhealthy && !healthy) process.exitCode = 1;
}

async function loadSlo(): Promise<OperationsSlo> {
    const sloPath = path.resolve(process.env.OPERATIONS_SLO_PATH ?? 'config/operations.slo.jsonc');
    return parseJsonc(await fs.readFile(sloPath, 'utf-8'), `operations SLO "${sloPath}"`) as OperationsSlo;
}

async function readRun(file: string): Promise<RunQualitySample | undefined> {
    const content = await fs.readFile(file, 'utf-8');
    try {
        return buildRunQualitySample(parseJsonlV2(content), file);
    } catch {
        return undefined;
    }
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

function parseArgs(args: string[]): {
    directory: string;
    sinceHours: number;
    maxCandidates: number;
    failOnUnhealthy: boolean;
} {
    let directory = path.resolve(process.env.TRACE_DIR ?? 'var/traces');
    let sinceHours = 24;
    let maxCandidates = 20;
    let failOnUnhealthy = false;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--') continue;
        if (args[index] === '--dir') directory = path.resolve(args[++index] ?? '');
        else if (args[index] === '--since-hours') sinceHours = Number(args[++index]);
        else if (args[index] === '--max-candidates') maxCandidates = Number(args[++index]);
        else if (args[index] === '--fail-on-unhealthy') failOnUnhealthy = true;
        else throw new Error(`unknown argument: ${args[index]}`);
    }
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new Error('--since-hours must be positive');
    if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) {
        throw new Error('--max-candidates must be a positive integer');
    }
    return { directory, sinceHours, maxCandidates, failOnUnhealthy };
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
