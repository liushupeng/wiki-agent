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

/**
 * RAG 检索评测入口。
 *
 * 用法：
 * - npm run eval:rag
 * - npm run eval:rag -- <questionsFile>
 *
 * 这个脚本只评估检索层，不调用 LLM。RAG_EVAL_MODE 支持 vector、grep、both。
 * 它适合在调整 chunker、embedding、vector store 或 grep 策略后，
 * 快速观察 topK 召回是否仍然命中预期笔记和关键词。
 */
async function main() {
    const questionsFile = path.resolve(process.argv[2] ?? 'evaluation/rag/questions.json');
    if (process.argv[3]) throw new Error('eval:rag reads the active index profile; pass no index file');
    const sourceRoots = await getKnowledgeSourceRoots();
    const mode = (process.env.RAG_EVAL_MODE ?? 'vector').toLowerCase();
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const vectorStore = await openActiveIndex(process.env.RAG_EVAL_PROFILE);
    const options = { wikiFirst: false };
    const vectorRetriever = createVectorEvalRetriever(vectorStore, options);
    const grepRetriever = createGrepEvalRetriever(sourceRoots, options);

    if (mode === 'vector') {
        console.log(JSON.stringify(await evaluateRetriever(questions, vectorRetriever), null, 2));
        return;
    }

    if (mode === 'grep') {
        console.log(JSON.stringify(await evaluateRetriever(questions, grepRetriever), null, 2));
        return;
    }

    if (mode === 'both') {
        const comparison: EvalComparisonSummary = {
            status: 'success',
            mode: 'both',
            vector: await evaluateRetriever(questions, vectorRetriever),
            grep: await evaluateRetriever(questions, grepRetriever)
        };
        console.log(JSON.stringify(comparison, null, 2));
        return;
    }

    throw new Error(`unsupported RAG_EVAL_MODE: ${mode}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
