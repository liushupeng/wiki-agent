import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { Embedder, TfEmbedder } from './embeddings.js';
import { IndexedChunk, KnowledgeIndex, SearchResult, Vector } from './types.js';

export type IndexMetadata = {
    createdAt?: string;
    chunkSize: number;
    overlap: number;
};

/**
 * 向量检索后端的稳定接口。
 *
 * RAG 工具和索引 pipeline 都依赖这个接口，而不是依赖某个具体数据库。
 * 后续实验 LanceDB、pgvector、Qdrant 等方案时，只需要新增 adapter 实现。
 */
export interface VectorStore {
    readonly name: string;
    replaceChunks(
        chunks: AsyncIterable<IndexedChunk>,
        metadata: IndexMetadata
    ): Promise<void>;
    search(query: string, topK?: number): Promise<SearchResult[]>;
    findBySource(source: string): Promise<IndexedChunk[]>;
    findRelated(source: string, topK?: number): Promise<SearchResult[]>;
}

/**
 * 默认 JSON 向量存储。
 *
 * 它把所有 chunks 写入一个 JSON 文件，查询时全量加载并计算相似度。
 * 这个实现适合本地实验、单元测试和理解 RAG 数据流；数据量变大或进入生产时，
 * 可以新增 LanceDB/pgvector/Qdrant adapter，并继续满足 VectorStore 接口。
 */
export class JsonVectorStore implements VectorStore {
    readonly name = 'json';

    constructor(
        readonly filePath: string,
        private readonly embedder: Embedder = new TfEmbedder()
    ) {}

    async replaceChunks(
        chunks: AsyncIterable<IndexedChunk>,
        metadata: IndexMetadata
    ): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

        try {
            handle = await fs.open(temporaryPath, 'wx');
            await handle.writeFile([
                '{',
                '  "version": 1,',
                `  "createdAt": ${JSON.stringify(metadata.createdAt ?? new Date().toISOString())},`,
                `  "chunkSize": ${metadata.chunkSize},`,
                `  "overlap": ${metadata.overlap},`,
                '  "chunks": ['
            ].join('\n'));

            let first = true;
            for await (const chunk of chunks) {
                await handle.writeFile(`${first ? '\n' : ',\n'}    ${JSON.stringify(chunk)}`);
                first = false;
            }

            await handle.writeFile('\n  ]\n}\n');
            await handle.close();
            handle = undefined;
            await fs.rename(temporaryPath, this.filePath);
        } catch (error) {
            await handle?.close().catch(() => undefined);
            await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async search(query: string, topK = 5): Promise<SearchResult[]> {
        const index = await loadKnowledgeIndex(this.filePath);
        const queryVector = await this.embedder.embed(query);

        return index.chunks
            .map(chunk => ({ ...chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
            .filter(chunk => chunk.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    async findBySource(source: string): Promise<IndexedChunk[]> {
        const index = await loadKnowledgeIndex(this.filePath);
        const normalized = normalizeSource(source);
        return index.chunks.filter(chunk => normalizeSource(chunk.source) === normalized);
    }

    async findRelated(source: string, topK = 8): Promise<SearchResult[]> {
        const noteChunks = await this.findBySource(source);
        const seedText = noteChunks.map(chunk => [
            chunk.titlePath?.join(' '),
            chunk.tags?.join(' '),
            chunk.links?.join(' '),
            chunk.text
        ].filter(Boolean).join('\n')).join('\n');

        if (!seedText.trim()) return [];

        const results = await this.search(seedText, topK + noteChunks.length);
        const normalizedSource = normalizeSource(source);
        return results.filter(chunk => normalizeSource(chunk.source) !== normalizedSource).slice(0, topK);
    }
}

/**
 * 根据环境变量创建检索后端。
 *
 * RAG 工具和脚本入口都通过这个工厂拿 VectorStore，避免直接依赖 JSON 实现。
 * 新增向量库时，在这里增加 RAG_STORE 分支即可。
 */
export function createVectorStoreFromEnv(options: { filePath?: string; storeName?: string } = {}): VectorStore {
    const storeName = (options.storeName ?? process.env.RAG_STORE ?? 'json').toLowerCase();
    const filePath = path.resolve(options.filePath ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');

    if (storeName === 'json') {
        return new JsonVectorStore(filePath);
    }

    throw new Error(`unsupported RAG_STORE: ${storeName}`);
}

export function cosineSimilarity(left: Vector, right: Vector): number {
    let score = 0;
    const [small, large] = Object.keys(left).length < Object.keys(right).length ? [left, right] : [right, left];

    for (const key of Object.keys(small)) {
        score += small[key] * (large[key] ?? 0);
    }

    return score;
}

export async function loadKnowledgeIndex(filePath: string): Promise<KnowledgeIndex> {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as KnowledgeIndex;
}

function normalizeSource(source: string): string {
    return source.replace(/\\/g, '/').toLowerCase();
}
