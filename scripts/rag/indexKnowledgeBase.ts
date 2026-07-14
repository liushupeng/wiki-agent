import path from 'path';
import { createEmbedderFromEnv } from '../../src/rag/embeddings.js';
import { runIndexPipeline } from '../../src/rag/indexPipeline.js';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

/**
 * RAG 索引入口。
 *
 * 用法：
 * - npm run index:notes
 * - npm run index:notes -- <notesDir>
 * - npm run index:notes -- <notesDir> <indexPath>
 *
 * 默认读取 NOTES_ROOT 或 notes/，默认写入 var/knowledge/index.json。
 * RAG_STORE、RAG_EMBEDDER 和 RAG_CHUNKER 控制实验方案；当前内置 json/tf/auto。
 * 这个文件只负责解析 CLI/env 配置并启动索引 pipeline；新增文件切分策略、
 * embedding 实现或向量库时，优先扩展 rag/ 下的 adapter，而不是改这里。
 */
async function main() {
    const sourceDir = path.resolve(process.argv[2] ?? process.env.NOTES_ROOT ?? 'notes');
    const outputFile = path.resolve(process.argv[3] ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
    const chunkSize = Number(process.env.RAG_CHUNK_SIZE ?? 900);
    const overlap = Number(process.env.RAG_CHUNK_OVERLAP ?? 120);
    const chunker = (process.env.RAG_CHUNKER ?? 'auto').toLowerCase();
    if (chunker !== 'auto') {
        throw new Error(`unsupported RAG_CHUNKER: ${chunker}`);
    }

    const stats = await runIndexPipeline({
        sourceDir,
        chunkSize,
        overlap,
        embedder: createEmbedderFromEnv(),
        vectorStore: createVectorStoreFromEnv({ filePath: outputFile })
    });

    console.log(`Indexed ${stats.chunkCount} note chunks from ${stats.documentCount} files -> ${outputFile}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
