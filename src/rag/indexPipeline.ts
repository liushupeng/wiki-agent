import path from 'path';
import { chunkDocument } from './chunker.js';
import { iterateSourceDocuments } from './documentLoader.js';
import { Embedder } from './embeddings.js';
import { IndexedChunk, SourceDocument } from './types.js';
import { VectorStore } from './vectorStore.js';

export type IndexPipelineConfig = {
    sourceDir: string;
    chunkSize: number;
    overlap: number;
    vectorStore: VectorStore;
    embedder: Embedder;
    documents?: AsyncIterable<SourceDocument>;
    onProgress?: (progress: IndexPipelineProgress) => void;
};

export type IndexPipelineProgress = {
    documentCount: number;
    chunkCount: number;
    currentSource: string;
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
    const embedder = config.embedder;
    const documents = config.documents ?? iterateSourceDocuments(sourceDir);
    let documentCount = 0;
    let chunkCount = 0;

    async function* generateIndexedChunks(): AsyncGenerator<IndexedChunk> {
        for await (const document of documents) {
            documentCount += 1;
            const chunks = chunkDocument(document, config.chunkSize, config.overlap);
            for (const chunk of chunks) {
                chunkCount += 1;
                yield {
                    ...chunk,
                    vector: await embedder.embed(chunk.text)
                };
            }
            config.onProgress?.({
                documentCount,
                chunkCount,
                currentSource: document.source
            });
        }
    }

    await config.vectorStore.replaceChunks(generateIndexedChunks(), {
        chunkSize: config.chunkSize,
        overlap: config.overlap
    });

    return {
        sourceDir,
        documentCount,
        chunkCount,
        chunkSize: config.chunkSize,
        overlap: config.overlap,
        embedder: embedder.name,
        store: config.vectorStore.name
    };
}
