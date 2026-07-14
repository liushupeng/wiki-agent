import fs from 'fs/promises';
import path from 'path';
import { EvalQuestion, evaluateRag } from '../../src/rag/evaluation.js';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

/**
 * RAG 检索评测入口。
 *
 * 用法：
 * - npm run eval:rag
 * - npm run eval:rag -- <questionsFile>
 * - npm run eval:rag -- <questionsFile> <indexFile>
 *
 * 这个脚本只评估检索层，不调用 LLM。它适合在调整 chunker、embedding
 * 或 vector store 后，快速观察 topK 召回是否仍然命中预期笔记和关键词。
 */
async function main() {
    const questionsFile = path.resolve(process.argv[2] ?? 'examples/rag-eval/questions.json');
    const indexFile = path.resolve(process.argv[3] ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const vectorStore = createVectorStoreFromEnv({ filePath: indexFile });

    console.log(JSON.stringify(await evaluateRag(questions, vectorStore), null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
