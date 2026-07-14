import path from 'path';
import { chunkDocument } from './chunker.js';
import { loadSourceDocuments } from './documentLoader.js';
import { Embedder, TfEmbedder } from './embeddings.js';
import { IndexedChunk, SourceDocument } from './types.js';
import { VectorStore } from './vectorStore.js';

export type IndexPipelineConfig = {
    sourceDir: string;
    chunkSize: number;
    overlap: number;
    vectorStore: VectorStore;
    embedder?: Embedder;
    documents?: SourceDocument[];
};

export type IndexPipelineStats = {
    sourceDir: string;
    documentCount: number;
    chunkCount: number;
    chunkSize: number;
    overlap: number;
    embedder: string;
    store: string;
};

/**
 * 索引构建的主编排流程。
 *
 * 这里固定的是数据流：加载文档 -> 切 chunk -> 生成向量 -> 写入 VectorStore。
 * 可变的是每一步的具体实现：不同文件类型可以扩展 chunker，不同 embedding
 * 方案可以实现 Embedder，不同向量库可以实现 VectorStore。
 */
export async function runIndexPipeline(config: IndexPipelineConfig): Promise<IndexPipelineStats> {
    const sourceDir = path.resolve(config.sourceDir);
    const embedder = config.embedder ?? new TfEmbedder();
    const documents = config.documents ?? await loadSourceDocuments(sourceDir);
    const indexedChunks: IndexedChunk[] = [];

    for (const document of documents) {
        const chunks = chunkDocument(document, config.chunkSize, config.overlap);
        for (const chunk of chunks) {
            indexedChunks.push({
                ...chunk,
                vector: await embedder.embed(chunk.text)
            });
        }
    }

    await config.vectorStore.upsertChunks(indexedChunks, {
        chunkSize: config.chunkSize,
        overlap: config.overlap
    });

    return {
        sourceDir,
        documentCount: documents.length,
        chunkCount: indexedChunks.length,
        chunkSize: config.chunkSize,
        overlap: config.overlap,
        embedder: embedder.name,
        store: config.vectorStore.name
    };
}
