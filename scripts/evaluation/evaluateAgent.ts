import fs from 'node:fs/promises';
import path from 'node:path';
import '../../src/env.js';
import { WikiAgent } from '../../src/agent.js';
import { AgentConfig } from '../../src/types.js';
import { MemoryManager } from '../../src/context/memory.js';
import { registerConfiguredMcpTools } from '../../src/mcp/register.js';
import { WIKI_AGENT_SYSTEM_PROMPT } from '../../src/prompts/systemPrompt.js';
import { buildSkillManifestPrompt, loadSkillManifests } from '../../src/skills.js';
import { createDefaultTools, getLocalToolNamesCoveredByMcp } from '../../src/tools/defaultTools.js';
import { ToolExposureController } from '../../src/tools/exposure.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentEvalQuestion, collectAgentTraceMetrics, parseJsonlV2, scoreAgentAnswer, validateAgentEvalQuestions } from '../../src/evaluation/agent.js';
import { selectAgentEvalQuestions, summarizeAgentResults, summarizeAgentResultsByCategory } from '../../src/evaluation/agent.js';
import { verifyTrajectory } from '../../src/evaluation/trajectoryVerifier.js';
import { getEvaluationExperiment, parseEvaluationMode, getSourceConfigIdentity } from '../../src/evaluation/experiments.js';
import { agentUsage, parseAgentEvalCommand } from '../../src/evaluation/cli.js';
import { createCliProgressReporter } from '../../src/evaluation/cliProgress.js';
import { FileReviewArtifactWriter, NoopReviewTracePublisher, ReviewPair } from '../../src/evaluation/reviewArtifacts.js';
import {
    EvalQuestionCheckpoint,
    EvalRunManifest,
    loadEvalQuestionCheckpoint,
    validateEvalResumeManifest,
    writeJsonAtomic
} from '../../src/evaluation/evalCheckpoint.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
import { loadRetrievalProfilesConfig, resolveRetrievalProfile } from '../../src/rag/retrievalProfiles.js';
import { openRetriever } from '../../src/rag/retrievalPipeline.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Agent 评测入口。
 *
 * 无参数或 --help 只输出帮助，不创建 Agent 且绝不调用 LLM。执行时必须用
 * --all、--random-count 或 --question-ids 显式选择题目，避免意外全量评测。
 */
type AgentEvalRun = {
    status: 'success' | 'partial';
    questionsFile: string;
    outputDirectory: string;
    total: number;
    passed: number;
    passRate: number;
    selectedTotal: number;
    results: ReturnType<typeof scoreAgentAnswer>[];
};
type AgentEvalResult = ReturnType<typeof scoreAgentAnswer>;
const execFileAsync = promisify(execFile);
const DEFAULT_EVAL_MAX_STEPS = 8;
const DEFAULT_EVAL_MAX_OUTPUT_TOKENS = 2_048;
const EVAL_REQUEST_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
    const command = parseAgentEvalCommand(process.argv.slice(2));
    if (command.action === 'help') {
        console.log(agentUsage());
        return;
    }
    const startedAt = performance.now();
    const arguments_ = command.args;
    const questionsFile = path.resolve(arguments_.questionsFile ?? 'evaluation/questions.json');
    const questions = validateAgentEvalQuestions(JSON.parse(await fs.readFile(questionsFile, 'utf-8')));
    const selectedQuestions = selectAgentEvalQuestions(questions, {
        randomCount: arguments_.randomCount,
        seed: arguments_.seed,
        questionIds: arguments_.questionIds
    });
    const experimentModes = parseEvaluationMode(arguments_.variant);
    const maxSteps = arguments_.maxSteps ?? DEFAULT_EVAL_MAX_STEPS;
    const maxOutputTokens = arguments_.maxOutputTokens ?? DEFAULT_EVAL_MAX_OUTPUT_TOKENS;
    const indexesConfig = await loadRagIndexesConfig();
    const retrievalProfilesConfig = await loadRetrievalProfilesConfig();
    const retrievalProfile = resolveRetrievalProfile(retrievalProfilesConfig, arguments_.retrievalProfile);
    const variantProfileId = retrievalProfile.mode === 'single'
        ? retrievalProfile.indexProfile
        : retrievalProfile.sparseProfile;
    const gitCommit = await readGitCommit();
    const gitStatus = await readGitStatus();
    if (!gitCommit) throw new Error('agent evaluation requires a Git commit for reproducibility');
    if (gitStatus) {
        throw new Error(`agent evaluation requires a clean Git worktree; commit or stash these changes first:\n${gitStatus}`);
    }
    const manifest: EvalRunManifest = {
        schemaVersion: 1,
        questionsFile,
        questionSetSha256: await sha256File(questionsFile),
        selectedQuestionIds: selectedQuestions.map(question => question.id),
        modes: experimentModes,
        retrievalProfile: retrievalProfile.id,
        model: process.env.MODEL_NAME ?? 'deepseek-v4-flash',
        maxSteps,
        maxOutputTokens,
        gitCommit,
        createdAt: new Date().toISOString()
    };
    await runPreflight({ manifest, questions: selectedQuestions, indexesConfig, variantProfileId });
    if (arguments_.preflight) return;

    const outputDirectory = arguments_.resumeDirectory
        ? path.resolve(arguments_.resumeDirectory)
        : path.resolve('var/evals/agent', new Date().toISOString().replace(/[:.]/g, '-'));
    if (arguments_.resumeDirectory) {
        await validateEvalResumeManifest(outputDirectory, manifest);
    } else {
        await fs.mkdir(outputDirectory, { recursive: true });
        await writeJsonAtomic(path.join(outputDirectory, 'run-manifest.json'), manifest);
    }
    console.log([
        `[agent] 已选 ${selectedQuestions.length}/${questions.length} 道题；变体：${experimentModes.join(', ')}。`,
        `[agent] 检索 Profile：${manifest.retrievalProfile}。`,
        `[agent] 模型：${manifest.model}；全局最大步骤：${maxSteps}；最大输出：${maxOutputTokens} tokens；API 自动重试：0。`,
        `[agent] 输出目录：${outputDirectory}`,
        arguments_.resumeDirectory ? '[agent] 断点续跑：已完成题目将从 result.json 恢复，不会再次调用模型。' : ''
    ].filter(Boolean).join('\n'));
    const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
    const systemPrompt = skillManifestPrompt
        ? `${WIKI_AGENT_SYSTEM_PROMPT}\n\n${skillManifestPrompt}`
        : WIKI_AGENT_SYSTEM_PROMPT;
    const runs: Record<string, AgentEvalRun> = {};
    const pairs = new Map<string, { question: AgentEvalQuestion; rawOnly?: ReturnType<typeof scoreAgentAnswer>; rawWiki?: ReturnType<typeof scoreAgentAnswer>; traceFile?: string; traceId?: string }>();
    let newQuestionsExecuted = 0;
        for (const mode of experimentModes) {
            const experiment = getEvaluationExperiment(mode);
            const profile = resolveRagIndexProfile(indexesConfig, variantProfileId);
            const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
            const modeStartedAt = performance.now();
            console.log(`[agent] [${mode}] 正在初始化 ${manifest.retrievalProfile}/${variant.id}（MCP、工具与索引）…`);
            const registry = new ToolRegistry();
            const exposureController = new ToolExposureController();
            const mcpRegistration = await registerConfiguredMcpTools(registry);
            const localToolNamesCoveredByMcp = getLocalToolNamesCoveredByMcp(mcpRegistration.tools);
            for (const tool of await createDefaultTools({
                skipToolNames: localToolNamesCoveredByMcp,
                exposureController,
                rag: {
                    indexProfile: profile.id,
                    retrievalProfile: manifest.retrievalProfile,
                    indexVariant: variant.id,
                    sourceConfigPath: variant.sourceConfigPath
                }
            })) {
                registry.register(tool);
            }
            registry.setSchemaFilter(tool => exposureController.shouldExpose(tool));
            console.log(`[agent] [${mode}] 初始化完成，开始评测 ${selectedQuestions.length} 道题。`);
            const progress = createCliProgressReporter();
            const results: ReturnType<typeof scoreAgentAnswer>[] = [];
            try {
              for (const [index, question] of selectedQuestions.entries()) {
                const questionStartedAt = performance.now();
                const progressMessage = `[agent] [${mode}] [${index + 1}/${selectedQuestions.length}]: ${question.id}`;
                if (index === 0) progress.start(progressMessage);
                else progress.update(progressMessage, true);
                const questionDirectory = path.join(outputDirectory, mode, `${String(index + 1).padStart(3, '0')}-${safePathSegment(question.id)}`);
                const checkpointPath = path.join(questionDirectory, 'result.json');
                const checkpoint = await loadEvalQuestionCheckpoint(checkpointPath, mode, question.id);
                if (checkpoint) {
                    results.push(checkpoint.result);
                    updateReviewPair(pairs, question, mode, checkpoint.result, checkpoint.traceId, checkpoint.traceFile);
                    progress.update(`${progressMessage} RESTORED，不调用模型。`);
                    continue;
                }
                if (arguments_.maxNewQuestions !== undefined && newQuestionsExecuted >= arguments_.maxNewQuestions) {
                    progress.update(`${progressMessage} DEFERRED，已达到 --max-new-questions ${arguments_.maxNewQuestions}。`);
                    break;
                }

                const attemptDirectory = path.join(questionDirectory, 'attempts', new Date().toISOString().replace(/[:.]/g, '-'));
                const traceDir = path.join(attemptDirectory, 'traces');
                await fs.mkdir(questionDirectory, { recursive: true });
                exposureController.resetToCore();
                const memory = new MemoryManager(systemPrompt, { memoryDirectory: path.join(attemptDirectory, 'memory') });
                const effectiveMaxSteps = Math.min(maxSteps, question.contract?.trajectory?.maxSteps ?? maxSteps);
                newQuestionsExecuted += 1;
                try {
                    const agent = new WikiAgent({
                        modelName: manifest.model, temperature: 0.1,
                        maxLoopSteps: effectiveMaxSteps,
                        maxRagCalls: question.contract?.tools?.maxRagCalls,
                        maxOutputTokens,
                        maxRetries: 0,
                        requestTimeoutMs: EVAL_REQUEST_TIMEOUT_MS,
                        traceDir, telemetryBackend: 'file',
                        capturePromptArtifacts: false, traceArtifactDir: path.join(attemptDirectory, 'prompt-artifacts'),
                        autoExportFileTrace: false, approvalMode: 'auto', requestApproval: async () => true
                    } satisfies AgentConfig, memory, registry);
                    const answer = await agent.run(question.question, () => {});
                    const trace = await readOnlyTrace(traceDir);
                    const records = parseJsonlV2(trace);
                    const traceMetrics = collectAgentTraceMetrics(records);
                    if (traceMetrics.terminationReason === 'system_error') {
                        throw new Error(`agent run terminated with system_error for ${question.id}; checkpoint was not committed`);
                    }
                    const verification = question.contract
                        ? verifyTrajectory({ contract: question.contract, question, answer, records })
                        : undefined;
                    const result = scoreAgentAnswer(question, answer, traceMetrics, verification);
                    results.push(result);
                    const traceFile = path.relative(outputDirectory, traceDir);
                    const checkpoint: EvalQuestionCheckpoint = {
                        schemaVersion: 1,
                        mode,
                        questionId: question.id,
                        ...(records[0]?.traceId ? { traceId: records[0].traceId } : {}),
                        traceFile,
                        completedAt: new Date().toISOString(),
                        result
                    };
                    await writeJsonAtomic(checkpointPath, checkpoint);
                    await fs.rm(path.join(questionDirectory, 'failure.json'), { force: true });
                    updateReviewPair(pairs, question, mode, result, checkpoint.traceId, traceFile);
                    progress.update(`${progressMessage} ${result.passed ? 'PASS' : 'FAIL'}，耗时 ${Math.round(performance.now() - questionStartedAt)} ms。`);
                } catch (error) {
                    await writeJsonAtomic(path.join(questionDirectory, 'failure.json'), {
                        schemaVersion: 1,
                        mode,
                        questionId: question.id,
                        failedAt: new Date().toISOString(),
                        attemptDirectory: path.relative(outputDirectory, attemptDirectory),
                        error: error instanceof Error ? error.message : String(error)
                    });
                    throw error;
                } finally {
                    memory.close();
                }
              }
            } finally {
                progress.stop();
                await mcpRegistration.close();
            }
            const passed = results.filter(result => result.passed).length;
            const status = results.length === selectedQuestions.length ? 'success' : 'partial';
            runs[mode] = { status, questionsFile, outputDirectory, selectedTotal: selectedQuestions.length, total: results.length, passed, passRate: results.length ? Number((passed / results.length).toFixed(4)) : 0, results };
            console.log(`[agent] [${mode}] ${status === 'success' ? '完成' : '部分完成'}：${passed}/${results.length} 通过，已保存 ${results.length}/${selectedQuestions.length}，耗时 ${Math.round(performance.now() - modeStartedAt)} ms。`);
        }
        const reviewPairs: ReviewPair[] = Array.from(pairs.values()).map(pair => ({ id: pair.question.id, question: pair.question.question, category: pair.question.category, rawOnly: pair.rawOnly, rawWiki: pair.rawWiki, traceId: pair.traceId, traceFile: pair.traceFile }));
        console.log('[agent] 正在生成复核评测包与报告…');
        const artifacts = await new FileReviewArtifactWriter().write(reviewPairs, path.join(outputDirectory, 'review'));
        await new NoopReviewTracePublisher().publish({ artifactPath: artifacts.reviewJsonlPath, sha256: artifacts.sha256 });
        const comparisons = reviewPairs.map(pair => ({
            id: pair.id,
            outcome: pair.rawOnly && pair.rawWiki
                ? pair.rawOnly.passed === pair.rawWiki.passed
                    ? 'unchanged'
                    : pair.rawWiki.passed
                        ? 'improved'
                        : 'regressed'
                : 'single-mode'
        }));
        const report = {
            status: Object.values(runs).every(run => run.status === 'success') ? 'success' : 'partial',
            questionsFile, outputDirectory,
            metadata: {
                gitCommit: manifest.gitCommit, questionSetSha256: manifest.questionSetSha256,
                retrievalProfile: manifest.retrievalProfile,
                model: manifest.model, temperature: 0.1, maxSteps, maxOutputTokens, maxRetries: 0,
                selectedQuestionIds: selectedQuestions.map(question => question.id), executedAt: new Date().toISOString(),
                experiments: await Promise.all(Object.keys(runs).map(async mode => {
                    const experiment = getEvaluationExperiment(mode as 'raw-only' | 'raw-wiki');
                    const profile = resolveRagIndexProfile(indexesConfig, variantProfileId);
                    const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
                    return {
                        mode,
                        retrievalProfile: manifest.retrievalProfile,
                        indexVariant: variant.id,
                        sourceConfig: await getSourceConfigIdentity(variant.sourceConfigPath)
                    };
                }))
            },
            runs,
            summary: Object.fromEntries(Object.entries(runs).map(([mode, run]) => [mode, {
                overall: summarizeAgentResults(run.results),
                byCategory: summarizeAgentResultsByCategory(run.results),
                verification: summarizeVerification(run.results),
                tokenUsage: summarizeTokenUsage(run.results)
            }])),
            comparisons,
            reviewArtifacts: artifacts
        };
        await writeJsonAtomic(path.join(outputDirectory, 'report.json'), report);
        printSummary(runs, comparisons, artifacts, outputDirectory, performance.now() - startedAt);
}

async function runPreflight(input: {
    manifest: EvalRunManifest;
    questions: AgentEvalQuestion[];
    indexesConfig: Awaited<ReturnType<typeof loadRagIndexesConfig>>;
    variantProfileId: string;
}): Promise<void> {
    console.log('[agent] Preflight：验证题集、完整检索管线与模型端点；不会生成 token。');
    const checkedVariants = new Set<string>();
    for (const mode of input.manifest.modes) {
        const experiment = getEvaluationExperiment(mode as 'raw-only' | 'raw-wiki');
        const profile = resolveRagIndexProfile(input.indexesConfig, input.variantProfileId);
        const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
        const key = `${input.manifest.retrievalProfile}/${variant.id}`;
        if (checkedVariants.has(key)) continue;
        const retriever = await openRetriever(input.manifest.retrievalProfile, variant.id);
        const probe = await retriever.retrieve(input.questions[0]!.question, { topK: 3 });
        checkedVariants.add(key);
        console.log(`[agent] Preflight 检索通过：${key}，返回 ${probe.evidences.length} 条证据，管线耗时 ${Math.round(probe.elapsedMs.total)} ms。`);
    }
    await verifyModelEndpoint(input.manifest.model);
    const maximumModelCalls = input.manifest.modes.length * input.questions.reduce((sum, question) =>
        sum + Math.min(input.manifest.maxSteps, question.contract?.trajectory?.maxSteps ?? input.manifest.maxSteps), 0);
    console.log([
        `[agent] Preflight 模型通过：${input.manifest.model} @ ${new URL(process.env.BASE_URL!).origin}。`,
        `[agent] 付费任务数：${input.questions.length * input.manifest.modes.length}；模型调用硬上限：${maximumModelCalls}。`,
        `[agent] 单次最大输出：${input.manifest.maxOutputTokens} tokens；SDK 自动重试：0。`
    ].join('\n'));
}

async function verifyModelEndpoint(model: string): Promise<void> {
    const baseUrl = process.env.BASE_URL?.trim();
    const apiKey = process.env.API_KEY?.trim();
    if (!baseUrl || !apiKey) throw new Error('preflight requires BASE_URL and API_KEY');
    const endpoint = new URL('models', `${baseUrl.replace(/\/+$/, '')}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await fetch(endpoint, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`model endpoint returned ${response.status} ${response.statusText}`);
        const payload = await response.json() as { data?: Array<{ id?: unknown }> };
        const modelIds = (payload.data ?? []).flatMap(item => typeof item.id === 'string' ? [item.id] : []);
        if (!modelIds.includes(model)) {
            throw new Error(`configured model "${model}" was not returned by ${endpoint}; available: ${modelIds.join(', ') || 'none'}`);
        }
    } finally {
        clearTimeout(timeout);
    }
}

function updateReviewPair(
    pairs: Map<string, { question: AgentEvalQuestion; rawOnly?: AgentEvalResult; rawWiki?: AgentEvalResult; traceFile?: string; traceId?: string }>,
    question: AgentEvalQuestion,
    mode: string,
    result: AgentEvalResult,
    traceId: string | undefined,
    traceFile: string
): void {
    const pair = pairs.get(question.id) ?? { question };
    if (mode === 'raw-only') pair.rawOnly = result;
    else pair.rawWiki = result;
    pair.traceId = traceId;
    pair.traceFile = traceFile;
    pairs.set(question.id, pair);
}

async function readOnlyTrace(traceDir: string): Promise<string> {
    const traceFiles = (await fs.readdir(traceDir))
        .filter(file => file.endsWith('.jsonl'))
        .sort();
    if (traceFiles.length !== 1) {
        throw new Error(`expected exactly one JSONL trace in ${traceDir}, found ${traceFiles.length}`);
    }
    return fs.readFile(path.join(traceDir, traceFiles[0]!), 'utf-8');
}

async function sha256File(file: string): Promise<string> {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function readGitCommit(): Promise<string | undefined> {
    try {
        return (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function readGitStatus(): Promise<string | undefined> {
    try {
        return (await execFileAsync('git', ['status', '--short'])).stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function summarizeVerification(results: ReturnType<typeof scoreAgentAnswer>[]) {
    const verified = results.filter(result => result.verification);
    const passed = verified.filter(result => result.verification?.passed).length;
    const failures = new Map<string, number>();
    for (const result of verified) {
        for (const dimension of result.verification?.summary.failedDimensions ?? []) {
            failures.set(dimension, (failures.get(dimension) ?? 0) + 1);
        }
    }
    return {
        total: verified.length,
        passed,
        passRate: verified.length ? Number((passed / verified.length).toFixed(4)) : 0,
        failedDimensions: Object.fromEntries(failures)
    };
}

function summarizeTokenUsage(results: ReturnType<typeof scoreAgentAnswer>[]) {
    return results.reduce((total, result) => {
        const usage = result.trace.tokenUsage;
        return {
            inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
            outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
            totalTokens: total.totalTokens + (usage?.totalTokens ?? 0),
            estimatedInputTokens: total.estimatedInputTokens + (usage?.estimatedInputTokens ?? 0),
            estimatedOutputTokens: total.estimatedOutputTokens + (usage?.estimatedOutputTokens ?? 0)
        };
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0 });
}

function printSummary(
    runs: Record<string, AgentEvalRun>,
    comparisons: Array<{ id: string; outcome: string }>,
    artifacts: Awaited<ReturnType<FileReviewArtifactWriter['write']>>,
    outputDirectory: string,
    elapsedMs: number
): void {
    console.log('[agent] 汇总：');
    for (const [mode, run] of Object.entries(runs)) {
        const aggregate = summarizeAgentResults(run.results);
        const toolFailures = run.results.reduce((count, result) => count + result.trace.toolFailures.length, 0);
        console.log([
            `  ${mode}`,
            `通过 ${run.passed}/${run.total} (${formatPercent(run.passRate)})`,
            `平均步骤 ${aggregate.averageSteps}`,
            `延迟 平均 ${formatDuration(aggregate.averageLatencyMs)} / P50 ${formatDuration(aggregate.p50LatencyMs)} / P95 ${formatDuration(aggregate.p95LatencyMs)}`,
            `工具失败 ${toolFailures}`
        ].join(' | '));
    }
    if (comparisons.some(comparison => comparison.outcome !== 'single-mode')) {
        const count = (outcome: string) => comparisons.filter(comparison => comparison.outcome === outcome).length;
        console.log(`  raw-wiki 对比 raw-only：改善 ${count('improved')} | 退化 ${count('regressed')} | 不变 ${count('unchanged')}`);
    }
    console.log(`[agent] 总耗时：${formatElapsed(elapsedMs)}`);
    console.log(`[agent] 详细报告：${path.join(outputDirectory, 'report.json')}`);
    console.log(`[agent] 人工复核：${artifacts.reviewJsonlPath} | ${artifacts.reviewCsvPath} | ${artifacts.reviewHtmlPath}`);
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number): string {
    return `${Math.round(value)} ms`;
}

function formatElapsed(value: number): string {
    return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
