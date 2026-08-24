import fs from 'fs/promises';
import path from 'path';
import '../../src/env.js';
import {
    EvalComparisonSummary,
    EvalQuestion,
    EvalRetrievalDecision,
    EvalRetriever,
    EvalSummary,
    createGrepEvalRetriever,
    createPipelineEvalRetriever,
    createVectorEvalRetriever,
    evaluateRetriever,
    normalizeEvalQuestion,
    scoreQuestion
} from '../../src/rag/evaluation.js';
import { openActiveIndex } from '../../src/rag/indexRuntime.js';
import { openRetriever } from '../../src/rag/retrievalPipeline.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { getEvaluationExperiment, parseEvaluationMode } from '../../src/evaluation/experiments.js';
import { parseRecallEvalCommand, recallUsage } from '../../src/evaluation/cli.js';
import { createCliProgressReporter } from '../../src/evaluation/cliProgress.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
import {
    retrievalCandidatesTraceAttributes,
    retrievalRequestTraceAttributes,
    retrievalResultTraceAttributes,
    retrievalStageTraceAttributes,
    retrievalSpanTraceAttributes
} from '../../src/rag/retrievalDiagnostics.js';
import { createTelemetry, SpanHandle, Telemetry } from '../../src/trace/telemetry.js';

/**
 * RAG 检索评测入口。
 *
 * 通过 `npm run eval:recall` 显式调用；无参数或 `--help` 只显示帮助，不读取
 * 题集和索引。正式执行可选择 raw-only/raw-wiki 语料变体以及 vector/grep
 * 检索器，按题检查候选召回、Top-K 来源与预期关键词，汇总 Recall、Hit@K、
 * MRR 和严格通过率，并将逐阶段 Trace 与 report.json 写入
 * var/evals/recall/。适合在调整 chunker、索引、embedding、融合、重排或 grep
 * 策略后做离线回归；只评估检索层，不调用 LLM，也不修改正式索引。
 */
async function main() {
    const command = parseRecallEvalCommand(process.argv.slice(2));
    if (command.action === 'help') {
        console.log(recallUsage());
        return;
    }
    const startedAt = performance.now();
    const arguments_ = command.args;
    if (arguments_.probeCandidateLimit !== undefined && arguments_.probeCandidateLimit <= 20) {
        throw new Error('--probe-candidate-limit must be greater than the normal candidate limit (20)');
    }
    const questionsFile = path.resolve(arguments_.questionsFile ?? 'evaluation/questions.json');
    const loadedQuestions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const requestedQuestionIds = new Set(arguments_.questionIds ?? []);
    const questions = requestedQuestionIds.size
        ? loadedQuestions.filter(question => question.id && requestedQuestionIds.has(question.id))
        : loadedQuestions;
    if (requestedQuestionIds.size) {
        const found = new Set(questions.map(question => question.id));
        const missing = [...requestedQuestionIds].filter(id => !found.has(id));
        if (missing.length) throw new Error(`unknown evaluation question ids: ${missing.join(', ')}`);
    }
    const results: Record<string, EvalSummary | EvalComparisonSummary> = {};
    const probes: Record<string, Record<string, ProbeSummary>> = {};
    const wikiFirstByVariant: Record<string, boolean> = {};
    const indexesConfig = await loadRagIndexesConfig();
    const experimentModes = parseEvaluationMode(arguments_.variant);
    const outputDirectory = path.resolve('var/evals/recall', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(outputDirectory, { recursive: true });
    const telemetry = createTelemetry({
        backend: 'file',
        traceDir: path.join(outputDirectory, 'traces'),
        serviceName: 'wiki-agent-eval'
    });
    const evalSpan = await telemetry.startSpan('eval.recall', {
        attributes: {
            'gen_ai.operation.name': 'evaluation',
            'wiki_agent.eval.questions_file': questionsFile,
            'wiki_agent.eval.question_count': questions.length,
            'wiki_agent.rag.profile': arguments_.retrievalProfile ?? arguments_.profile,
            'wiki_agent.eval.variant': arguments_.variant,
            'wiki_agent.eval.retriever': arguments_.retriever
        }
    });
    console.log(`[recall] 已加载 ${questions.length} 道题；Profile：${arguments_.retrievalProfile ?? arguments_.profile}；变体：${experimentModes.join(', ')}；检索器：${arguments_.retriever}；Wiki 优先：${arguments_.wikiFirst === undefined ? '按变体默认值' : arguments_.wikiFirst}`);

    try {
        for (const experimentMode of experimentModes) {
            const experiment = getEvaluationExperiment(experimentMode);
            const profile = resolveRagIndexProfile(indexesConfig, arguments_.profile);
            const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
            const options = { wikiFirst: arguments_.wikiFirst ?? experiment.wikiFirst };
            wikiFirstByVariant[experimentMode] = options.wikiFirst;
            console.log(`[recall] [${experimentMode}] 正在加载检索 ${arguments_.retrievalProfile ?? profile.id}/${variant.id}（Wiki 优先：${options.wikiFirst}）…`);
            const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: variant.sourceConfigPath });
            const vectorRetriever = arguments_.retrievalProfile
                ? createPipelineEvalRetriever(await openRetriever(arguments_.retrievalProfile, variant.id))
                : createVectorEvalRetriever(await openActiveIndex(profile.id, variant.id), options);
            const grepRetriever = createGrepEvalRetriever(sourceRoots, options);
            results[experimentMode] = await evaluate(
                experimentMode,
                arguments_.retriever,
                questions,
                vectorRetriever,
                grepRetriever,
                { telemetry, evalSpan, profile: arguments_.retrievalProfile ?? profile.id, variant: variant.id, wikiFirst: options.wikiFirst },
                arguments_.probeCandidateLimit,
                (retrieverName, probe) => {
                    probes[experimentMode] ??= {};
                    probes[experimentMode][retrieverName] = probe;
                }
            );
        }
        const report = {
            status: 'success',
            questionsFile,
            createdAt: new Date().toISOString(),
            profile: arguments_.profile,
            ...(arguments_.retrievalProfile ? { retrievalProfile: arguments_.retrievalProfile } : {}),
            retriever: arguments_.retriever,
            variant: arguments_.variant,
            ...(arguments_.questionIds ? { questionIds: arguments_.questionIds } : {}),
            wikiFirst: wikiFirstByVariant,
            ...(arguments_.probeCandidateLimit === undefined ? {} : { probeCandidateLimit: arguments_.probeCandidateLimit, probes }),
            traceFile: telemetry.filePath,
            experiments: results
        };
        await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        await evalSpan.end({
            status: 'ok',
            attributes: {
                'wiki_agent.eval.total_elapsed_ms': Math.round(performance.now() - startedAt),
                'wiki_agent.eval.summary': JSON.stringify(summarizeForTrace(results))
            }
        });
        printSummary(arguments_.retrievalProfile ?? arguments_.profile, results, outputDirectory, performance.now() - startedAt, telemetry.filePath, probes);
    } catch (error) {
        await evalSpan.end({ status: 'error', attributes: { 'error.message': error instanceof Error ? error.message : String(error) } });
        throw error;
    } finally {
        await telemetry.shutdown();
    }
}

async function evaluate(
    experimentMode: string,
    retriever: 'vector' | 'grep' | 'both',
    questions: EvalQuestion[],
    vector: EvalRetriever,
    grep: ReturnType<typeof createGrepEvalRetriever>,
    trace: RetrievalTraceContext,
    probeCandidateLimit: number | undefined,
    onProbe: (retrieverName: string, probe: ProbeSummary) => void
): Promise<EvalSummary | EvalComparisonSummary> {
    if (retriever === 'vector') return evaluateWithProgress(experimentMode, questions, vector, trace, probeCandidateLimit, onProbe);
    if (retriever === 'grep') return evaluateWithProgress(experimentMode, questions, grep, trace, probeCandidateLimit, onProbe);
    if (retriever === 'both') {
        const comparison: EvalComparisonSummary = {
            status: 'success',
            mode: 'both',
            vector: await evaluateWithProgress(experimentMode, questions, vector, trace, probeCandidateLimit, onProbe),
            grep: await evaluateWithProgress(experimentMode, questions, grep, trace, probeCandidateLimit, onProbe)
        };
        return comparison;
    }
    throw new Error(`unsupported retriever: ${retriever}`);
}

async function evaluateWithProgress(
    experimentMode: string,
    questions: EvalQuestion[],
    retriever: EvalRetriever,
    trace: RetrievalTraceContext,
    probeCandidateLimit: number | undefined,
    onProbe: (retrieverName: string, probe: ProbeSummary) => void
) {
    const startedAt = performance.now();
    const progress = createCliProgressReporter();
    const summary = await evaluateRetriever(questions, retriever, 5, ({ completed, total, question }) => {
        const message = `[recall] [${experimentMode}/${retriever.name}] [${completed}/${total}]: ${question.id}`;
        if (completed === 1) progress.start(message);
        else progress.update(message);
    }, decision => writeRetrievalTrace(trace, decision));
    progress.stop();
    console.log(`[recall] [${experimentMode}/${retriever.name}] 完成：${summary.passed}/${summary.total} 宽松通过，${summary.strictPassed}/${summary.total} 严格通过，耗时 ${Math.round(performance.now() - startedAt)} ms。`);
    if (probeCandidateLimit !== undefined) {
        const probe = await probeCandidateMisses(questions, summary, retriever, trace, probeCandidateLimit);
        onProbe(retriever.name, probe);
        console.log(`[recall] [${experimentMode}/${retriever.name}] 深度探测：${probe.total} 个 candidate miss，恢复 ${probe.recovered}，仍未命中 ${probe.stillMissing}（candidateLimit=${probe.candidateLimit}）。`);
    }
    return summary;
}

type RetrievalTraceContext = {
    telemetry: Telemetry;
    evalSpan: SpanHandle;
    profile: string;
    variant: string;
    wikiFirst: boolean;
};

type ProbeSummary = {
    candidateLimit: number;
    total: number;
    recovered: number;
    stillMissing: number;
};

async function probeCandidateMisses(
    questions: EvalQuestion[],
    summary: EvalSummary,
    retriever: EvalRetriever,
    trace: RetrievalTraceContext,
    candidateLimit: number
): Promise<ProbeSummary> {
    const misses = summary.results
        .map((result, index) => ({ result, index }))
        .filter(({ result }) => result.candidateSourceHit === false);
    let recovered = 0;

    for (const { index } of misses) {
        const question = normalizeEvalQuestion(questions[index]!, index);
        const startedAt = new Date();
        const startedAtMs = performance.now();
        const candidates = retriever.candidateSearch
            ? await retriever.candidateSearch(question, candidateLimit)
            : await retriever.search(question, candidateLimit);
        const matches = retriever.rerank ? retriever.rerank(candidates, 5) : candidates.slice(0, 5);
        const result = scoreQuestion(question, matches, candidates);
        if (result.candidateSourceHit) recovered += 1;
        await writeRetrievalTrace(trace, {
            question,
            retriever: retriever.name,
            topK: 5,
            candidateLimit,
            candidates,
            matches,
            result,
            startedAt,
            elapsedMs: performance.now() - startedAtMs
        }, { reason: 'candidate_miss' });
    }

    return {
        candidateLimit,
        total: misses.length,
        recovered,
        stillMissing: misses.length - recovered
    };
}

async function writeRetrievalTrace(
    context: RetrievalTraceContext,
    decision: EvalRetrievalDecision,
    probe?: { reason: 'candidate_miss' }
): Promise<void> {
    const span = await context.evalSpan.startChild('rag.search', {
        kind: 'client',
        startedAt: decision.startedAt,
        attributes: {
            ...retrievalSpanTraceAttributes({
                query: decision.question.question,
                mode: decision.retriever as 'vector' | 'grep',
                topK: decision.topK,
                candidateLimit: decision.candidateLimit,
                profile: context.profile,
                variant: context.variant,
                wikiFirst: context.wikiFirst
            }),
            'wiki_agent.eval.question_id': decision.question.id,
            'wiki_agent.eval.experiment_mode': context.variant,
            ...(probe ? { 'wiki_agent.rag.probe': true, 'wiki_agent.rag.probe_reason': probe.reason } : {})
        }
    });
    const retrieval = {
        query: decision.question.question,
        mode: decision.retriever as 'vector' | 'grep',
        topK: decision.topK,
        candidateLimit: decision.candidateLimit,
        profile: context.profile,
        variant: context.variant,
        wikiFirst: context.wikiFirst,
        candidates: decision.candidates,
        matches: decision.matches,
        elapsedMs: decision.elapsedMs
    };
    await span.addEvent('retrieval.request', retrievalRequestTraceAttributes(retrieval));
    await span.addEvent('retrieval.candidates', retrievalCandidatesTraceAttributes(retrieval));
    for (const [stage, matches] of Object.entries(decision.stages ?? {})) {
        await span.addEvent(`retrieval.stage.${stage}`, retrievalStageTraceAttributes(matches));
    }
    await span.addEvent('retrieval.result', retrievalResultTraceAttributes(retrieval));
    const expectedSources = decision.result.expectedSources ?? (decision.question.expectedSource ? [decision.question.expectedSource] : []);
    const candidateRank = rankOfExpectedSource(decision.candidates, expectedSources);
    const finalRank = rankOfExpectedSource(decision.matches, expectedSources);
    const failureType = !expectedSources.length
        ? 'unlabeled'
        : candidateRank === undefined
            ? 'candidate_miss'
            : finalRank === undefined
                ? 'final_rank_miss'
                : decision.result.strictPassed
                    ? 'pass'
                    : 'source_term_coverage_miss';
    await span.addEvent('gen_ai.evaluation.result', {
        'gen_ai.evaluation.name': 'retrieval_evidence',
        'gen_ai.evaluation.score.value': decision.result.strictPassed ? 1 : 0,
        'gen_ai.evaluation.score.label': decision.result.strictPassed ? 'pass' : 'fail',
        'wiki_agent.eval.expected_sources': JSON.stringify(expectedSources),
        'wiki_agent.eval.candidate_rank': candidateRank ?? -1,
        'wiki_agent.eval.final_rank': finalRank ?? -1,
        ...(decision.result.stageRanks
            ? { 'wiki_agent.eval.stage_ranks': JSON.stringify(decision.result.stageRanks) }
            : {}),
        ...(decision.result.stageDiagnostics
            ? { 'wiki_agent.eval.stage_diagnostics': JSON.stringify(decision.result.stageDiagnostics) }
            : {}),
        'wiki_agent.eval.term_coverage': decision.result.termScore,
        'wiki_agent.eval.source_term_coverage': decision.result.sourceTermScore,
        'wiki_agent.eval.loose_passed': decision.result.passed,
        'wiki_agent.eval.strict_passed': decision.result.strictPassed,
        'wiki_agent.eval.failure_type': failureType
    });
    await span.end({
        status: 'ok'
    });
}

function rankOfExpectedSource(matches: Array<{ source: string }>, expectedSources: string[]): number | undefined {
    const rank = matches.findIndex(match => expectedSources.some(expected => match.source.toLowerCase().includes(expected.toLowerCase())));
    return rank < 0 ? undefined : rank + 1;
}

function summarizeForTrace(results: Record<string, EvalSummary | EvalComparisonSummary>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(results).map(([variant, result]) => [
        variant,
        isComparisonSummary(result)
            ? { vector: result.vector.metrics, grep: result.grep.metrics }
            : result.metrics
    ]));
}

function printSummary(
    profile: string,
    results: Record<string, EvalSummary | EvalComparisonSummary>,
    outputDirectory: string,
    elapsedMs: number,
    traceFile?: string,
    probes: Record<string, Record<string, ProbeSummary>> = {}
): void {
    console.log('[recall] 汇总：');
    console.log('[recall] 指标口径：Recall@20/100 为融合候选池；Hit@5、Hit@1、MRR@5 为最终 Top-5 排序结果；阶段恢复/回退按 60% 目标关键词覆盖率统计。');
    for (const [variant, result] of Object.entries(results)) {
        const summaries: EvalSummary[] = isComparisonSummary(result)
            ? [result.vector, result.grep]
            : [result];
        for (const summary of summaries) {
            const metrics = summary.metrics;
            console.log([
                `  ${profile}/${variant}/${summary.retriever}`,
                `宽松通过 ${summary.passed}/${summary.total}`,
                `严格通过 ${summary.strictPassed}/${summary.total}`,
                `Recall@20 ${formatRatio(metrics?.candidateRecallAtK)}`,
                `Recall@100 ${formatRatio(metrics?.candidateRecallAt100)}`,
                `20→100 恢复 ${metrics?.recoveredBetween20And100 ?? 'n/a'}`,
                `Missing@100 ${metrics?.stillMissingAt100 ?? 'n/a'}`,
                `Hit@5 ${formatRatio(metrics?.recallAtK)}`,
                `Hit@1 ${formatRatio(metrics?.hitAt1)}`,
                `MRR@5 ${formatRatio(metrics?.mrr)}`
            ].join(' | '));
            if (metrics?.stageTransitions) {
                const transitions = Object.entries(metrics.stageTransitions)
                    .filter(([, value]) => value.recovered || value.regressed)
                    .map(([stage, value]) => `${stage} +${value.recovered}/-${value.regressed}`);
                if (transitions.length) console.log(`    阶段内容恢复/回退：${transitions.join(' | ')}`);
            }
            if (metrics?.performance) {
                const elapsed = metrics.performance.elapsedMs;
                const stages = ['sparse', 'dense', 'candidateCache', 'fusion', 'chunkRerank', 'sourceLocal', 'evidenceAssembly', 'evidenceRerank', 'total']
                    .filter(stage => elapsed[stage])
                    .map(stage => `${stage} p50/p95 ${formatElapsed(elapsed[stage]!.p50)}/${formatElapsed(elapsed[stage]!.p95)}`);
                console.log(`    阶段耗时：${stages.join(' | ')}`);
                const candidateCache = metrics.performance.cache.candidates;
                const rerankerCache = metrics.performance.cache.reranker;
                console.log(`    缓存：候选 ${candidateCache.hits}/${candidateCache.requests} (${formatRatio(candidateCache.hitRate)}) | Reranker ${rerankerCache.hits}/${rerankerCache.requests} (${formatRatio(rerankerCache.hitRate)})`);
                const counts = metrics.performance.candidateCounts;
                console.log(`    文档数（均值/p95）：${Object.entries(counts).map(([stage, value]) => `${stage} ${value.mean}/${value.p95}`).join(' | ')}`);
            }
        }
    }
    for (const [variant, retrievers] of Object.entries(probes)) {
        for (const [retriever, probe] of Object.entries(retrievers)) {
            console.log(`  ${profile}/${variant}/${retriever} probe@${probe.candidateLimit} | candidate miss ${probe.total} | 恢复 ${probe.recovered} | 仍未命中 ${probe.stillMissing}`);
        }
    }
    console.log(`[recall] 总耗时：${formatElapsed(elapsedMs)}`);
    if (traceFile) console.log(`[recall] Trace：${traceFile}`);
    console.log(`[recall] 详细报告：${path.join(outputDirectory, 'report.json')}`);
}

function isComparisonSummary(value: EvalSummary | EvalComparisonSummary): value is EvalComparisonSummary {
    return 'mode' in value && value.mode === 'both';
}

function formatRatio(value: number | undefined): string {
    return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatElapsed(value: number): string {
    return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
