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
import { AgentEvalQuestion, collectAgentTraceMetrics, parseJsonlV2, scoreAgentAnswer } from '../../src/evaluation/agent.js';
import { selectAgentEvalQuestions, summarizeAgentResults, summarizeAgentResultsByCategory } from '../../src/evaluation/agent.js';
import { getEvaluationExperiment, parseEvaluationMode, getSourceConfigIdentity } from '../../src/evaluation/experiments.js';
import { agentUsage, parseAgentEvalCommand } from '../../src/evaluation/cli.js';
import { createCliProgressReporter } from '../../src/evaluation/cliProgress.js';
import { FileReviewArtifactWriter, NoopReviewTracePublisher, ReviewPair } from '../../src/evaluation/reviewArtifacts.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
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
    status: 'success';
    questionsFile: string;
    outputDirectory: string;
    total: number;
    passed: number;
    passRate: number;
    results: ReturnType<typeof scoreAgentAnswer>[];
};
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
    const command = parseAgentEvalCommand(process.argv.slice(2));
    if (command.action === 'help') {
        console.log(agentUsage());
        return;
    }
    const arguments_ = command.args;
    const questionsFile = path.resolve(arguments_.questionsFile ?? 'evaluation/questions.json');
    const questions = validateQuestions(JSON.parse(await fs.readFile(questionsFile, 'utf-8')));
    const selectedQuestions = selectAgentEvalQuestions(questions, {
        randomCount: arguments_.randomCount,
        seed: arguments_.seed,
        questionIds: arguments_.questionIds
    });
    const outputDirectory = path.resolve('var/evals/agent', new Date().toISOString().replace(/[:.]/g, '-'));
    const experimentModes = parseEvaluationMode(arguments_.variant);
    console.log([
        `[agent] 已选 ${selectedQuestions.length}/${questions.length} 道题；变体：${experimentModes.join(', ')}。`,
        `[agent] 模型：${process.env.MODEL_NAME ?? 'deepseek-v4-pro'}；最大步骤：${process.env.MAX_LOOP_STEPS ?? 20}。`,
        `[agent] 输出目录：${outputDirectory}`
    ].join('\n'));
    const skillManifestPrompt = buildSkillManifestPrompt(await loadSkillManifests());
    const systemPrompt = skillManifestPrompt
        ? `${WIKI_AGENT_SYSTEM_PROMPT}\n\n${skillManifestPrompt}`
        : WIKI_AGENT_SYSTEM_PROMPT;
    const indexesConfig = await loadRagIndexesConfig();
    const runs: Record<string, AgentEvalRun> = {};
    const pairs = new Map<string, { question: AgentEvalQuestion; rawOnly?: ReturnType<typeof scoreAgentAnswer>; rawWiki?: ReturnType<typeof scoreAgentAnswer>; traceFile?: string; traceId?: string }>();
        for (const mode of experimentModes) {
            const experiment = getEvaluationExperiment(mode);
            const profile = resolveRagIndexProfile(indexesConfig, experiment.indexProfile);
            const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
            const modeStartedAt = performance.now();
            console.log(`[agent] [${mode}] 正在初始化 ${profile.id}/${variant.id}（MCP、工具与索引）…`);
            const registry = new ToolRegistry();
            const exposureController = new ToolExposureController();
            const mcpRegistration = await registerConfiguredMcpTools(registry);
            const localToolNamesCoveredByMcp = getLocalToolNamesCoveredByMcp(mcpRegistration.tools);
            for (const tool of await createDefaultTools({
                skipToolNames: localToolNamesCoveredByMcp,
                exposureController,
                rag: { indexProfile: profile.id, indexVariant: variant.id, sourceConfigPath: variant.sourceConfigPath }
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
                const traceDir = path.join(questionDirectory, 'traces');
                await fs.mkdir(questionDirectory, { recursive: true });
                exposureController.resetToCore();
                const memory = new MemoryManager(systemPrompt, { memoryDirectory: path.join(questionDirectory, 'memory') });
                try {
                    const agent = new WikiAgent({
                        modelName: process.env.MODEL_NAME ?? 'deepseek-v4-pro', temperature: 0.1,
                        maxLoopSteps: Number(process.env.MAX_LOOP_STEPS ?? 20), traceDir, telemetryBackend: 'file',
                        capturePromptArtifacts: false, traceArtifactDir: path.join(questionDirectory, 'prompt-artifacts'),
                        autoExportFileTrace: false, approvalMode: 'auto', requestApproval: async () => true
                    } satisfies AgentConfig, memory, registry);
                    const answer = await agent.run(question.question, () => {});
                    const trace = await readOnlyTrace(traceDir);
                    const result = scoreAgentAnswer(question, answer, collectAgentTraceMetrics(parseJsonlV2(trace)));
                    results.push(result);
                    const pair = pairs.get(question.id) ?? { question };
                    if (mode === 'raw-only') pair.rawOnly = result; else pair.rawWiki = result;
                    pair.traceId = parseJsonlV2(trace)[0]?.traceId;
                    pair.traceFile = path.relative(outputDirectory, traceDir);
                    pairs.set(question.id, pair);
                    progress.update(`${progressMessage} ${result.passed ? 'PASS' : 'FAIL'}，耗时 ${Math.round(performance.now() - questionStartedAt)} ms。`);
                } finally {
                    memory.close();
                }
              }
            } finally {
                progress.stop();
                await mcpRegistration.close();
            }
            const passed = results.filter(result => result.passed).length;
            runs[mode] = { status: 'success', questionsFile, outputDirectory, total: results.length, passed, passRate: results.length ? Number((passed / results.length).toFixed(4)) : 0, results };
            console.log(`[agent] [${mode}] 完成：${passed}/${results.length} 通过，耗时 ${Math.round(performance.now() - modeStartedAt)} ms。`);
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
            status: 'success', questionsFile, outputDirectory,
            metadata: {
                gitCommit: await readGitCommit(), questionSetSha256: await sha256File(questionsFile),
                model: process.env.MODEL_NAME ?? 'deepseek-v4-pro', temperature: 0.1, maxSteps: Number(process.env.MAX_LOOP_STEPS ?? 20),
                selectedQuestionIds: selectedQuestions.map(question => question.id), executedAt: new Date().toISOString(),
                experiments: await Promise.all(Object.keys(runs).map(async mode => {
                    const experiment = getEvaluationExperiment(mode as 'raw-only' | 'raw-wiki');
                    const profile = resolveRagIndexProfile(indexesConfig, experiment.indexProfile);
                    const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
                    return { mode, indexProfile: profile.id, indexVariant: variant.id, sourceConfig: await getSourceConfigIdentity(variant.sourceConfigPath) };
                }))
            },
            runs,
            summary: Object.fromEntries(Object.entries(runs).map(([mode, run]) => [mode, {
                overall: summarizeAgentResults(run.results),
                byCategory: summarizeAgentResultsByCategory(run.results)
            }])),
            comparisons,
            reviewArtifacts: artifacts
        };
        await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
        printSummary(runs, comparisons, artifacts, outputDirectory);
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

function validateQuestions(value: unknown): AgentEvalQuestion[] {
    if (!Array.isArray(value)) throw new Error('agent eval questions must be a JSON array');
    return value.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error(`question ${index + 1} must be an object`);
        const question = item as Partial<AgentEvalQuestion>;
        if (!question.id?.trim() || !question.question?.trim()) {
            throw new Error(`question ${index + 1} requires non-empty id and question`);
        }
        return {
            id: question.id,
            question: question.question,
            ...(question.category ? { category: question.category } : {}),
            ...(question.queryType ? { queryType: question.queryType } : {}),
            ...(question.primaryStage ? { primaryStage: question.primaryStage } : {}),
            ...(question.difficulty ? { difficulty: question.difficulty } : {}),
            ...(question.expectedSource ? { expectedSource: question.expectedSource } : {}),
            ...(question.expectedTerms ? { expectedTerms: question.expectedTerms } : {})
        };
    });
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

function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function printSummary(
    runs: Record<string, AgentEvalRun>,
    comparisons: Array<{ id: string; outcome: string }>,
    artifacts: Awaited<ReturnType<FileReviewArtifactWriter['write']>>,
    outputDirectory: string
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
    console.log(`[agent] 详细报告：${path.join(outputDirectory, 'report.json')}`);
    console.log(`[agent] 人工复核：${artifacts.reviewJsonlPath} | ${artifacts.reviewCsvPath} | ${artifacts.reviewHtmlPath}`);
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number): string {
    return `${Math.round(value)} ms`;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
