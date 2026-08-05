import fs from 'fs/promises';
import path from 'path';
import '../../src/env.js';
import {
    EvalComparisonSummary,
    EvalQuestion,
    EvalSummary,
    createGrepEvalRetriever,
    createVectorEvalRetriever,
    evaluateRetriever
} from '../../src/rag/evaluation.js';
import { openActiveIndex } from '../../src/rag/indexRuntime.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { getEvaluationExperiment, parseEvaluationMode } from '../../src/evaluation/experiments.js';
import { parseRecallEvalCommand, recallUsage } from '../../src/evaluation/cli.js';
import { createCliProgressReporter } from '../../src/evaluation/cliProgress.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';

/**
 * RAG 检索评测入口。
 *
 * 用法：
 * - npm run eval:recall
 * - npm run eval:recall -- -- --variant both --retriever both
 *
 * 不带参数或传入 --help 时只打印帮助，不读取索引或题库。这个脚本只评估检索层，
 * 不调用 LLM。--variant 支持 raw-only、raw-wiki、both；
 * --retriever 支持 vector、grep、both。
 * 它适合在调整 chunker、embedding、vector store 或 grep 策略后，
 * 快速观察 topK 召回是否仍然命中预期笔记和关键词。
 */
async function main() {
    const command = parseRecallEvalCommand(process.argv.slice(2));
    if (command.action === 'help') {
        console.log(recallUsage());
        return;
    }
    const arguments_ = command.args;
    const questionsFile = path.resolve(arguments_.questionsFile ?? 'evaluation/questions.json');
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const results: Record<string, EvalSummary | EvalComparisonSummary> = {};
    const indexesConfig = await loadRagIndexesConfig();
    const experimentModes = parseEvaluationMode(arguments_.variant);
    console.log(`[recall] 已加载 ${questions.length} 道题；变体：${experimentModes.join(', ')}；检索器：${arguments_.retriever}`);

    for (const experimentMode of experimentModes) {
        const experiment = getEvaluationExperiment(experimentMode);
        const profile = resolveRagIndexProfile(indexesConfig, experiment.indexProfile);
        const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
        console.log(`[recall] [${experimentMode}] 正在加载索引 ${profile.id}/${variant.id}…`);
        const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: variant.sourceConfigPath });
        const vectorStore = await openActiveIndex(profile.id, variant.id);
        const options = { wikiFirst: experiment.wikiFirst };
        const vectorRetriever = createVectorEvalRetriever(vectorStore, options);
        const grepRetriever = createGrepEvalRetriever(sourceRoots, options);
        results[experimentMode] = await evaluate(experimentMode, arguments_.retriever, questions, vectorRetriever, grepRetriever);
    }
    const report = { status: 'success', questionsFile, createdAt: new Date().toISOString(), retriever: arguments_.retriever, variant: arguments_.variant, experiments: results };
    const outputDirectory = path.resolve('var/evals/recall', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    printSummary(results, outputDirectory);
}

async function evaluate(
    experimentMode: string,
    retriever: 'vector' | 'grep' | 'both',
    questions: EvalQuestion[],
    vector: ReturnType<typeof createVectorEvalRetriever>,
    grep: ReturnType<typeof createGrepEvalRetriever>
): Promise<EvalSummary | EvalComparisonSummary> {
    if (retriever === 'vector') return evaluateWithProgress(experimentMode, questions, vector);
    if (retriever === 'grep') return evaluateWithProgress(experimentMode, questions, grep);
    if (retriever === 'both') {
        const comparison: EvalComparisonSummary = {
            status: 'success',
            mode: 'both',
            vector: await evaluateWithProgress(experimentMode, questions, vector),
            grep: await evaluateWithProgress(experimentMode, questions, grep)
        };
        return comparison;
    }
    throw new Error(`unsupported retriever: ${retriever}`);
}

async function evaluateWithProgress(
    experimentMode: string,
    questions: EvalQuestion[],
    retriever: ReturnType<typeof createVectorEvalRetriever> | ReturnType<typeof createGrepEvalRetriever>
) {
    const startedAt = performance.now();
    const progress = createCliProgressReporter();
    const summary = await evaluateRetriever(questions, retriever, 5, ({ completed, total, question }) => {
        const message = `[recall] [${experimentMode}/${retriever.name}] [${completed}/${total}]: ${question.id}`;
        if (completed === 1) progress.start(message);
        else progress.update(message);
    });
    progress.stop();
    console.log(`[recall] [${experimentMode}/${retriever.name}] 完成：${summary.passed}/${summary.total} 通过，耗时 ${Math.round(performance.now() - startedAt)} ms。`);
    return summary;
}

function printSummary(results: Record<string, EvalSummary | EvalComparisonSummary>, outputDirectory: string): void {
    console.log('[recall] 汇总：');
    for (const [variant, result] of Object.entries(results)) {
        const summaries: EvalSummary[] = isComparisonSummary(result)
            ? [result.vector, result.grep]
            : [result];
        for (const summary of summaries) {
            const metrics = summary.metrics;
            console.log([
                `  ${variant}/${summary.retriever}`,
                `通过 ${summary.passed}/${summary.total}`,
                `Recall@5 ${formatRatio(metrics?.recallAtK)}`,
                `Candidate Recall@20 ${formatRatio(metrics?.candidateRecallAtK)}`,
                `Hit@1 ${formatRatio(metrics?.hitAt1)}`,
                `MRR ${formatRatio(metrics?.mrr)}`
            ].join(' | '));
        }
    }
    console.log(`[recall] 详细报告：${path.join(outputDirectory, 'report.json')}`);
}

function isComparisonSummary(value: EvalSummary | EvalComparisonSummary): value is EvalComparisonSummary {
    return 'mode' in value && value.mode === 'both';
}

function formatRatio(value: number | undefined): string {
    return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
