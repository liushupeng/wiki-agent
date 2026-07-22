import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { IndexedChunk, KnowledgeIndex, SearchResult, Vector } from './types.js';

export type VectorSearchScoring = {
    type: 'cosine';
} | {
    type: 'bm25';
    k1: number;
    b: number;
};

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
    search(vector: Vector, topK?: number): Promise<SearchResult[]>;
    findBySource(source: string): Promise<IndexedChunk[]>;
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
        private readonly scoring: VectorSearchScoring = { type: 'cosine' }
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
                    '  "version": 2,',
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

    async search(vector: Vector, topK = 5): Promise<SearchResult[]> {
        const index = await loadKnowledgeIndex(this.filePath);

        const scores = this.scoring.type === 'bm25'
            ? bm25Scores(index.chunks, vector, this.scoring)
            : index.chunks.map(chunk => ({ ...chunk, score: cosineSimilarity(vector, chunk.vector) }));

        return scores
            .filter(chunk => chunk.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    async findBySource(source: string): Promise<IndexedChunk[]> {
        const index = await loadKnowledgeIndex(this.filePath);
        const normalized = normalizeSource(source);
        return index.chunks.filter(chunk => normalizeSource(chunk.source) === normalized);
    }

}

export function createVectorStore(name: string, dataPath: string, scoring: VectorSearchScoring = { type: 'cosine' }): VectorStore {
    if (name === 'json') return new JsonVectorStore(path.resolve(dataPath), scoring);
    throw new Error(`unsupported RAG store: ${name}`);
}

function bm25Scores(chunks: IndexedChunk[], query: Vector, options: Extract<VectorSearchScoring, { type: 'bm25' }>): SearchResult[] {
    if (Array.isArray(query)) throw new Error('BM25 requires sparse term-frequency vectors');
    const queryTerms = Object.keys(query);
    if (queryTerms.length === 0) return [];
    if (chunks.some(chunk => Array.isArray(chunk.vector))) throw new Error('BM25 index contains dense vectors');

    const documentCount = chunks.length;
    const lengths = chunks.map(chunk => sparseVectorLength(chunk.vector as Record<string, number>));
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / Math.max(documentCount, 1);
    const documentFrequency = new Map<string, number>();
    for (const chunk of chunks) {
        const vector = chunk.vector as Record<string, number>;
        for (const term of queryTerms) {
            if (vector[term] !== undefined) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
    }

    return chunks.map((chunk, index) => {
        const vector = chunk.vector as Record<string, number>;
        const lengthNormalization = options.k1 * (1 - options.b + options.b * (lengths[index] / Math.max(averageLength, 1)));
        const score = queryTerms.reduce((sum, term) => {
            const termFrequency = vector[term] ?? 0;
            if (termFrequency === 0) return sum;
            const frequency = documentFrequency.get(term) ?? 0;
            const idf = Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
            return sum + idf * (termFrequency * (options.k1 + 1)) / (termFrequency + lengthNormalization);
        }, 0);
        return { ...chunk, score };
    });
}

function sparseVectorLength(vector: Record<string, number>): number {
    return Object.values(vector).reduce((sum, value) => sum + value, 0);
}

export function cosineSimilarity(left: Vector, right: Vector): number {
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) {
            throw new Error('cannot compare sparse and dense vectors');
        }
        if (left.length !== right.length) {
            throw new Error(`cannot compare dense vectors with different dimensions: ${left.length} and ${right.length}`);
        }
        return left.reduce((sum, value, index) => sum + value * right[index], 0);
    }
    let score = 0;
    const [small, large] = Object.keys(left).length < Object.keys(right).length ? [left, right] : [right, left];

    for (const key of Object.keys(small)) {
        score += small[key] * (large[key] ?? 0);
    }

    return score;
}

export async function loadKnowledgeIndex(filePath: string): Promise<KnowledgeIndex> {
    const content = await fs.readFile(filePath, 'utf-8');
    const value: unknown = JSON.parse(content);
    if (!isKnowledgeIndex(value)) {
        throw new Error(`invalid knowledge index (expected version 2): ${filePath}`);
    }
    return value;
}

function normalizeSource(source: string): string {
    return source.replace(/\\/g, '/').toLowerCase();
}

function isKnowledgeIndex(value: unknown): value is KnowledgeIndex {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && (value as { version?: unknown }).version === 2
        && Array.isArray((value as { chunks?: unknown }).chunks);
}
