import fs from 'fs/promises';
import path from 'path';
import { EvalComparisonSummary, EvalQuestion, evaluateRag, evaluateRetriever } from '../../src/rag/evaluation.js';
import { grepMatchesToSearchResults, grepNotes } from '../../src/rag/grep.js';
import { getKnowledgeSourceRoots, sourceWithPrefix } from '../../src/rag/sourceRoots.js';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

/**
 * RAG 检索评测入口。
 *
 * 用法：
 * - npm run eval:rag
 * - npm run eval:rag -- <questionsFile>
 * - npm run eval:rag -- <questionsFile> <indexFile>
 *
 * 这个脚本只评估检索层，不调用 LLM。RAG_EVAL_MODE 支持 vector、grep、both。
 * 它适合在调整 chunker、embedding、vector store 或 grep 策略后，
 * 快速观察 topK 召回是否仍然命中预期笔记和关键词。
 */
async function main() {
    const questionsFile = path.resolve(process.argv[2] ?? 'examples/rag-eval/questions.json');
    const indexFile = path.resolve(process.argv[3] ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
    const sourceRoots = getKnowledgeSourceRoots();
    const mode = (process.env.RAG_EVAL_MODE ?? 'vector').toLowerCase();
    const questions = JSON.parse(await fs.readFile(questionsFile, 'utf-8')) as EvalQuestion[];
    const vectorStore = createVectorStoreFromEnv({ filePath: indexFile });

    if (mode === 'vector') {
        console.log(JSON.stringify(await evaluateRag(questions, vectorStore), null, 2));
        return;
    }

    const grepSummary = () => evaluateRetriever(questions, {
        name: 'grep',
        async search(item, topK) {
            const query = item.grepQuery ?? item.question;
            const matches = (await Promise.all(sourceRoots.map(async sourceRoot => {
                const matchesForRoot = await grepNotes(path.resolve(sourceRoot.root), query, { maxResults: topK });
                return matchesForRoot.map(match => ({
                    ...match,
                    source: sourceWithPrefix(sourceRoot.prefix, match.source)
                }));
            }))).flat().slice(0, topK);
            return grepMatchesToSearchResults(matches, query);
        }
    });

    if (mode === 'grep') {
        console.log(JSON.stringify(await grepSummary(), null, 2));
        return;
    }

    if (mode === 'both') {
        const comparison: EvalComparisonSummary = {
            status: 'success',
            mode: 'both',
            vector: await evaluateRag(questions, vectorStore),
            grep: await grepSummary()
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
