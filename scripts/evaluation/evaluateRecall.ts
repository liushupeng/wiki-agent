import fs from 'fs/promises';
import path from 'path';
import '../../src/env.js';
import {
    EvalComparisonSummary,
    EvalQuestion,
    createGrepEvalRetriever,
    createVectorEvalRetriever,
    evaluateRetriever
} from '../../src/rag/evaluation.js';
import { openActiveIndex } from '../../src/rag/indexRuntime.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { getEvaluationExperiment, parseEvaluationMode } from '../../src/evaluation/experiments.js';
import { parseRecallEvalCommand, recallUsage } from '../../src/evaluation/cli.js';
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
    const results: Record<string, unknown> = {};
    const indexesConfig = await loadRagIndexesConfig();

    for (const experimentMode of parseEvaluationMode(arguments_.variant)) {
        const experiment = getEvaluationExperiment(experimentMode);
        const profile = resolveRagIndexProfile(indexesConfig, experiment.indexProfile);
        const variant = resolveRagIndexVariant(profile, experiment.indexVariant);
        const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: variant.sourceConfigPath });
        const vectorStore = await openActiveIndex(profile.id, variant.id);
        const options = { wikiFirst: experiment.wikiFirst };
        const vectorRetriever = createVectorEvalRetriever(vectorStore, options);
        const grepRetriever = createGrepEvalRetriever(sourceRoots, options);
        results[experimentMode] = await evaluate(arguments_.retriever, questions, vectorRetriever, grepRetriever);
    }
    const report = { status: 'success', questionsFile, createdAt: new Date().toISOString(), retriever: arguments_.retriever, variant: arguments_.variant, experiments: results };
    const outputDirectory = path.resolve('var/evals/recall', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, outputDirectory }, null, 2));
}

async function evaluate(retriever: 'vector' | 'grep' | 'both', questions: EvalQuestion[], vector: ReturnType<typeof createVectorEvalRetriever>, grep: ReturnType<typeof createGrepEvalRetriever>): Promise<unknown> {
    if (retriever === 'vector') return evaluateRetriever(questions, vector);
    if (retriever === 'grep') return evaluateRetriever(questions, grep);
    if (retriever === 'both') {
        const comparison: EvalComparisonSummary = { status: 'success', mode: 'both', vector: await evaluateRetriever(questions, vector), grep: await evaluateRetriever(questions, grep) };
        return comparison;
    }
    throw new Error(`unsupported retriever: ${retriever}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
