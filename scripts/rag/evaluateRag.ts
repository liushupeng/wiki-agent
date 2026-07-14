import fs from 'fs/promises';
import path from 'path';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

type EvalQuestion = {
    question: string;
    expectedSource?: string;
    expectedTerms?: string[];
};

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
    const results = [];

    for (const item of questions) {
        const matches = await vectorStore.search(item.question, 5);

        // 把 topK 检索结果合并成一个低成本判分文本，用 expectedTerms 检查召回内容是否包含关键事实。
        const combinedText = matches.map(match => `${match.source}\n${match.text}`).join('\n').toLowerCase();

        // expectedSource 评估“是否召回正确文档”；expectedTerms 评估“召回片段是否覆盖关键概念”。
        // 这里使用 60% 关键词命中率作为轻量阈值，避免单个同义词或切分差异导致评测过于脆弱。
        const sourceHit = item.expectedSource ? matches.some(match => match.source.includes(item.expectedSource!)) : true;
        const termHits = item.expectedTerms?.filter(term => combinedText.includes(term.toLowerCase())).length ?? 0;
        const termScore = item.expectedTerms?.length ? termHits / item.expectedTerms.length : 1;
        const passed = sourceHit && termScore >= 0.6;

        results.push({
            question: item.question,
            passed,
            sourceHit,
            termScore: Number(termScore.toFixed(2)),
            topSources: matches.map(match => ({ source: match.source, score: Number(match.score.toFixed(4)) }))
        });
    }

    const passedCount = results.filter(result => result.passed).length;
    console.log(JSON.stringify({
        status: 'success',
        passed: passedCount,
        total: results.length,
        accuracy: results.length ? Number((passedCount / results.length).toFixed(2)) : 0,
        results
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
