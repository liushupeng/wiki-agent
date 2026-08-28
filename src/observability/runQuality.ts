import type { JsonlV2Record } from '../evaluation/trajectoryModel.js';

export type EvidenceQualitySnapshot = {
    state?: 'insufficient' | 'partial' | 'sufficient';
    count: number;
    distinctSources: number;
    citedCount: number;
    truncatedCount: number;
    conflictedCount: number;
    lowAuthorityCount: number;
};

export type RunQualitySample = {
    traceId: string;
    traceFile?: string;
    startedAt: string;
    durationMs: number;
    completed: boolean;
    terminationReason?: string;
    instructionPreview?: string;
    instructionSha256?: string;
    model?: string;
    buildId?: string;
    stepCount: number;
    toolCalls: number;
    toolFailures: number;
    ragCalls: number;
    ragCacheHits: number;
    ragBudgetExhausted: boolean;
    fallbackCount: number;
    emptyRetrievals: number;
    retrievalLatenciesMs: number[];
    retrievalProfiles: string[];
    retrievalVariants: string[];
    indexIdentities: string[];
    totalTokens: number;
    evidence: EvidenceQualitySnapshot;
    finalAnswerAction?: 'allow' | 'forced-abstention';
    runArtifact?: {
        path: string;
        sha256?: string;
        chars?: number;
    };
};

export const CANDIDATE_SIGNALS = [
    'system_error',
    'max_loop_steps',
    'tool_failure',
    'rag_budget_exhausted',
    'insufficient_evidence',
    'partial_evidence',
    'fallback',
    'forced_abstention',
    'empty_retrieval'
] as const;

export type CandidateSignal = typeof CANDIDATE_SIGNALS[number];

export type RunQualitySummary = {
    runs: number;
    knowledgeRuns: number;
    sli: {
        completionRate: number | null;
        latencyMs: { p50: number | null; p95: number | null };
        retrievalLatencyMs: { p50: number | null; p95: number | null };
        toolFailureRate: number | null;
        ragRetrieverCacheHitRate: number | null;
        ragBudgetExhaustionRate: number | null;
        fallbackRate: number | null;
        emptyRetrievalRate: number | null;
        evidence: {
            insufficientRate: number | null;
            partialRate: number | null;
            sufficientRate: number | null;
        };
        forcedAbstentionRate: number | null;
        averageTotalTokens: number | null;
    };
    byRetrievalProfile: Record<string, {
        runs: number;
        completionRate: number | null;
        fallbackRate: number | null;
        evidenceInsufficientRate: number | null;
    }>;
    candidates: Partial<Record<CandidateSignal, Array<{ traceId: string; traceFile?: string }>>>;
};

export function buildRunQualitySample(
    records: JsonlV2Record[],
    traceFile?: string
): RunQualitySample | undefined {
    const starts = new Map<string, JsonlV2Record>();
    let rootStart: JsonlV2Record | undefined;
    let rootEnd: JsonlV2Record | undefined;
    let finalPolicyEvent: JsonlV2Record | undefined;
    let toolCalls = 0;
    let toolFailures = 0;
    let ragCalls = 0;
    let ragCacheHits = 0;
    let fallbackCount = 0;
    let emptyRetrievals = 0;
    let totalTokens = 0;
    const retrievalLatenciesMs: number[] = [];
    const profiles = new Set<string>();
    const variants = new Set<string>();
    const identities = new Set<string>();

    for (const record of records) {
        if (record.type === 'span_start') {
            starts.set(record.spanId, record);
            if (record.name === 'wiki_agent.run') rootStart = record;
            if (record.name === 'tool.execute') toolCalls += 1;
            if (record.name === 'rag.search') {
                ragCalls += 1;
                addString(profiles, record.attributes?.['wiki_agent.rag.profile']);
                addString(variants, record.attributes?.['wiki_agent.rag.variant']);
            }
            continue;
        }

        if (record.type === 'span_event') {
            if (record.name === 'final_answer.policy') finalPolicyEvent = record;
            const parent = starts.get(record.spanId);
            if (parent?.name === 'rag.search') {
                if (record.attributes?.['wiki_agent.rag.retriever_cache_hit'] === true) ragCacheHits += 1;
                if (record.attributes?.['wiki_agent.rag.fallback_used'] === true) fallbackCount += 1;
                if (record.name === 'retrieval.result') {
                    const count = optionalNumber(record.attributes?.['wiki_agent.rag.match_count']);
                    if (count === 0) emptyRetrievals += 1;
                    const latency = optionalNumber(record.attributes?.['wiki_agent.rag.latency_ms']);
                    if (latency !== undefined) retrievalLatenciesMs.push(latency);
                    addString(identities, record.attributes?.['wiki_agent.rag.index_identity']);
                }
            }
            continue;
        }

        const start = starts.get(record.spanId);
        if (start?.name === 'wiki_agent.run') rootEnd = record;
        if (start?.name === 'tool.execute' && record.status !== 'ok') toolFailures += 1;
        if (start?.name === 'gen_ai.chat') {
            totalTokens += optionalNumber(record.attributes?.['gen_ai.usage.total_tokens']) ?? 0;
        }
        if (start?.name === 'rag.search') {
            addString(profiles, record.attributes?.['wiki_agent.rag.profile']);
            addString(variants, record.attributes?.['wiki_agent.rag.variant']);
            addString(identities, record.attributes?.['wiki_agent.rag.index_identity']);
            if (record.attributes?.['wiki_agent.rag.fallback_used'] === true && fallbackCount === 0) fallbackCount += 1;
            const latency = optionalNumber(record.attributes?.['wiki_agent.rag.latency_ms']);
            if (latency !== undefined && retrievalLatenciesMs.length === 0) retrievalLatenciesMs.push(latency);
        }
    }

    if (!rootStart?.traceId || !rootStart.startedAt || !rootEnd?.endedAt) return undefined;
    const terminationReason = optionalString(rootEnd.attributes?.['wiki_agent.termination_reason']);
    const state = evidenceState(rootEnd.attributes?.['evidence.state']);
    const finalAction = finalAnswerAction(
        rootEnd.attributes?.['wiki_agent.final_answer.action']
        ?? finalPolicyEvent?.attributes?.['wiki_agent.final_answer.action']
    );
    const artifactPath = optionalString(rootEnd.attributes?.['wiki_agent.run_artifact.path']);
    return {
        traceId: rootStart.traceId,
        ...(traceFile ? { traceFile } : {}),
        startedAt: rootStart.startedAt,
        durationMs: Math.max(0, Date.parse(rootEnd.endedAt) - Date.parse(rootStart.startedAt)),
        completed: terminationReason === 'completed' || rootEnd.status === 'ok',
        ...(terminationReason ? { terminationReason } : {}),
        instructionPreview: optionalString(rootStart.attributes?.['wiki_agent.instruction']),
        instructionSha256: optionalString(rootStart.attributes?.['wiki_agent.instruction.sha256']),
        model: optionalString(rootStart.attributes?.['gen_ai.request.model']),
        buildId: optionalString(rootStart.attributes?.['wiki_agent.build_id']),
        stepCount: optionalNumber(rootEnd.attributes?.['wiki_agent.step_count']) ?? countSteps(records),
        toolCalls,
        toolFailures,
        ragCalls,
        ragCacheHits,
        ragBudgetExhausted: rootEnd.attributes?.['wiki_agent.rag.budget_exhausted'] === true,
        fallbackCount,
        emptyRetrievals,
        retrievalLatenciesMs,
        retrievalProfiles: [...profiles],
        retrievalVariants: [...variants],
        indexIdentities: [...identities],
        totalTokens,
        evidence: {
            ...(state ? { state } : {}),
            count: optionalNumber(rootEnd.attributes?.['evidence.count']) ?? 0,
            distinctSources: optionalNumber(rootEnd.attributes?.['evidence.distinct_sources']) ?? 0,
            citedCount: optionalNumber(rootEnd.attributes?.['evidence.cited_count']) ?? 0,
            truncatedCount: optionalNumber(rootEnd.attributes?.['evidence.truncated_count']) ?? 0,
            conflictedCount: optionalNumber(rootEnd.attributes?.['evidence.conflicted_count']) ?? 0,
            lowAuthorityCount: optionalNumber(rootEnd.attributes?.['evidence.low_authority_count']) ?? 0
        },
        ...(finalAction ? { finalAnswerAction: finalAction } : {}),
        ...(artifactPath ? {
            runArtifact: {
                path: artifactPath,
                ...(optionalString(rootEnd.attributes?.['wiki_agent.run_artifact.sha256'])
                    ? { sha256: optionalString(rootEnd.attributes?.['wiki_agent.run_artifact.sha256']) }
                    : {}),
                ...(optionalNumber(rootEnd.attributes?.['wiki_agent.run_artifact.chars']) !== undefined
                    ? { chars: optionalNumber(rootEnd.attributes?.['wiki_agent.run_artifact.chars']) }
                    : {})
            }
        } : {})
    };
}

export function candidateSignals(sample: RunQualitySample): CandidateSignal[] {
    const signals: CandidateSignal[] = [];
    if (sample.terminationReason === 'system_error') signals.push('system_error');
    if (sample.terminationReason === 'max_loop_steps') signals.push('max_loop_steps');
    if (sample.toolFailures > 0) signals.push('tool_failure');
    if (sample.ragBudgetExhausted) signals.push('rag_budget_exhausted');
    if (sample.ragCalls > 0 && sample.evidence.state === 'insufficient') signals.push('insufficient_evidence');
    if (sample.ragCalls > 0 && sample.evidence.state === 'partial') signals.push('partial_evidence');
    if (sample.fallbackCount > 0) signals.push('fallback');
    if (sample.finalAnswerAction === 'forced-abstention') signals.push('forced_abstention');
    if (sample.emptyRetrievals > 0) signals.push('empty_retrieval');
    return signals;
}

export function summarizeRunQuality(
    samples: RunQualitySample[],
    maxCandidatesPerSignal = 20
): RunQualitySummary {
    const knowledgeRuns = samples.filter(sample => sample.ragCalls > 0);
    const toolCalls = sum(samples.map(sample => sample.toolCalls));
    const ragCalls = sum(samples.map(sample => sample.ragCalls));
    const retrievalLatencies = samples.flatMap(sample => sample.retrievalLatenciesMs);
    const evidenceRate = (state: EvidenceQualitySnapshot['state']) =>
        ratio(knowledgeRuns.filter(sample => sample.evidence.state === state).length, knowledgeRuns.length);
    const profileSamples = new Map<string, RunQualitySample[]>();
    for (const sample of samples) {
        for (const profile of sample.retrievalProfiles) {
            const values = profileSamples.get(profile) ?? [];
            values.push(sample);
            profileSamples.set(profile, values);
        }
    }
    const candidates: RunQualitySummary['candidates'] = {};
    for (const sample of samples) {
        for (const signal of candidateSignals(sample)) {
            const values = candidates[signal] ?? [];
            if (values.length < maxCandidatesPerSignal) {
                values.push({
                    traceId: sample.traceId,
                    ...(sample.traceFile ? { traceFile: sample.traceFile } : {})
                });
            }
            candidates[signal] = values;
        }
    }
    return {
        runs: samples.length,
        knowledgeRuns: knowledgeRuns.length,
        sli: {
            completionRate: ratio(samples.filter(sample => sample.completed).length, samples.length),
            latencyMs: {
                p50: percentile(samples.map(sample => sample.durationMs), 0.5),
                p95: percentile(samples.map(sample => sample.durationMs), 0.95)
            },
            retrievalLatencyMs: {
                p50: percentile(retrievalLatencies, 0.5),
                p95: percentile(retrievalLatencies, 0.95)
            },
            toolFailureRate: ratio(sum(samples.map(sample => sample.toolFailures)), toolCalls),
            ragRetrieverCacheHitRate: ratio(sum(samples.map(sample => sample.ragCacheHits)), ragCalls),
            ragBudgetExhaustionRate: ratio(
                samples.filter(sample => sample.ragBudgetExhausted).length,
                samples.length
            ),
            fallbackRate: ratio(
                knowledgeRuns.filter(sample => sample.fallbackCount > 0).length,
                knowledgeRuns.length
            ),
            emptyRetrievalRate: ratio(sum(samples.map(sample => sample.emptyRetrievals)), ragCalls),
            evidence: {
                insufficientRate: evidenceRate('insufficient'),
                partialRate: evidenceRate('partial'),
                sufficientRate: evidenceRate('sufficient')
            },
            forcedAbstentionRate: ratio(
                knowledgeRuns.filter(sample => sample.finalAnswerAction === 'forced-abstention').length,
                knowledgeRuns.length
            ),
            averageTotalTokens: samples.length
                ? Math.round(sum(samples.map(sample => sample.totalTokens)) / samples.length)
                : null
        },
        byRetrievalProfile: Object.fromEntries([...profileSamples.entries()].map(([profile, values]) => {
            const profileKnowledgeRuns = values.filter(sample => sample.ragCalls > 0);
            return [profile, {
                runs: values.length,
                completionRate: ratio(values.filter(sample => sample.completed).length, values.length),
                fallbackRate: ratio(
                    profileKnowledgeRuns.filter(sample => sample.fallbackCount > 0).length,
                    profileKnowledgeRuns.length
                ),
                evidenceInsufficientRate: ratio(
                    profileKnowledgeRuns.filter(sample => sample.evidence.state === 'insufficient').length,
                    profileKnowledgeRuns.length
                )
            }];
        })),
        candidates
    };
}

function countSteps(records: JsonlV2Record[]): number {
    return records.filter(record =>
        record.type === 'span_start' && record.name?.startsWith('wiki_agent.step.')
    ).length;
}

function addString(target: Set<string>, value: unknown): void {
    const normalized = optionalString(value);
    if (normalized) target.add(normalized);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function evidenceState(value: unknown): EvidenceQualitySnapshot['state'] {
    return value === 'insufficient' || value === 'partial' || value === 'sufficient' ? value : undefined;
}

function finalAnswerAction(value: unknown): RunQualitySample['finalAnswerAction'] {
    return value === 'allow' || value === 'forced-abstention' ? value : undefined;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
    return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function percentile(values: number[], quantile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return Math.round(sorted[Math.ceil(quantile * sorted.length) - 1]!);
}
