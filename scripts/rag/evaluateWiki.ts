import fs from 'fs/promises';
import path from 'path';
import {
    EvalComparisonSummary,
    EvalQuestion,
    createGrepEvalRetriever,
    createVectorEvalRetriever,
    evaluateRetriever
} from '../../src/rag/evaluation.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

/**
 * Wiki 优先检索评测入口。
 *
 * 用法：
 * - npm run eval:wiki
 * - npm run eval:wiki -- <questionsFile>
 * - npm run eval:wiki -- <questionsFile> <indexFile>
 */
async function main() {
    const questionsFile = path.resolve(process.argv[2] ?? 'examples/wiki-eval/questions.json');
    const indexFile = path.resolve(process.argv[3] ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
    const sourceRoots = await getKnowledgeSourceRoots();
    const mode = (process.env.RAG_EVAL_MODE ?? 'vector').toLowerCase();
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const vectorStore = createVectorStoreFromEnv({ filePath: indexFile });
    const options = { wikiFirst: true };
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
