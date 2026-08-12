import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';
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
    private loadedIndex?: Promise<KnowledgeIndex>;

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
            this.loadedIndex = undefined;
        } catch (error) {
            await handle?.close().catch(() => undefined);
            await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async search(vector: Vector, topK = 5): Promise<SearchResult[]> {
        const index = await this.loadIndex();

        const scores = this.scoring.type === 'bm25'
            ? bm25Scores(index.chunks, vector, this.scoring)
            : index.chunks.map(chunk => ({ ...chunk, score: cosineSimilarity(vector, chunk.vector) }));

        return scores
            .filter(chunk => chunk.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    async findBySource(source: string): Promise<IndexedChunk[]> {
        const index = await this.loadIndex();
        const normalized = normalizeSource(source);
        return index.chunks.filter(chunk => normalizeSource(chunk.source) === normalized);
    }

    private loadIndex(): Promise<KnowledgeIndex> {
        this.loadedIndex ??= loadKnowledgeIndex(this.filePath).catch(error => {
            this.loadedIndex = undefined;
            throw error;
        });
        return this.loadedIndex;
    }

}

type LanceChunkRow = {
    id: string;
    source: string;
    text: string;
    start: number;
    end: number;
    titlePath: string;
    tags: string;
    links: string;
    frontmatter: string;
    vector: number[];
};

export class LanceDbVectorStore implements VectorStore {
    readonly name = 'lancedb';
    private readonly tableName = 'chunks';

    constructor(readonly databasePath: string) {}

    async replaceChunks(chunks: AsyncIterable<IndexedChunk>, _metadata: IndexMetadata): Promise<void> {
        await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
        const stagingPath = `${this.databasePath}.staging-${randomUUID()}`;
        const backupPath = `${this.databasePath}.backup-${randomUUID()}`;
        const connection = await lancedb.connect(stagingPath);
        let table: lancedb.Table | undefined;
        let batch: LanceChunkRow[] = [];
        try {
            for await (const chunk of chunks) {
                if (!Array.isArray(chunk.vector)) throw new Error('LanceDB requires dense vectors');
                batch.push(toLanceRow(chunk));
                if (batch.length >= 256) {
                    if (!table) table = await connection.createTable(this.tableName, batch);
                    else await table.add(batch);
                    batch = [];
                }
            }
            if (batch.length > 0) {
                if (!table) table = await connection.createTable(this.tableName, batch);
                else await table.add(batch);
            }
            if (!table) throw new Error('cannot create an empty LanceDB knowledge index');
            connection.close();
            const currentExists = await fs.stat(this.databasePath).then(() => true, () => false);
            if (currentExists) await fs.rename(this.databasePath, backupPath);
            try {
                await fs.rename(stagingPath, this.databasePath);
                if (currentExists) await fs.rm(backupPath, { recursive: true, force: true });
            } catch (error) {
                if (currentExists) await fs.rename(backupPath, this.databasePath).catch(() => undefined);
                throw error;
            }
        } catch (error) {
            connection.close();
            await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }

    async search(vector: Vector, topK = 5): Promise<SearchResult[]> {
        if (!Array.isArray(vector)) throw new Error('LanceDB requires dense query vectors');
        const connection = await lancedb.connect(this.databasePath);
        try {
            const table = await connection.openTable(this.tableName);
            const rows = await table
                .vectorSearch(vector)
                .distanceType('cosine')
                .select(['id', 'source', 'text', 'start', 'end', 'titlePath', 'tags', 'links', 'frontmatter'])
                .limit(topK)
                .toArray();
            return rows.map(row => fromLanceRow(row, 1 - Number(row._distance ?? 1)));
        } finally {
            connection.close();
        }
    }

    async findBySource(source: string): Promise<IndexedChunk[]> {
        const connection = await lancedb.connect(this.databasePath);
        try {
            const table = await connection.openTable(this.tableName);
            const escaped = source.replaceAll("'", "''");
            const rows = await table
                .query()
                .where(`source = '${escaped}'`)
                .select(['id', 'source', 'text', 'start', 'end', 'titlePath', 'tags', 'links', 'frontmatter'])
                .toArray();
            return rows.map(row => {
                const result = fromLanceRow(row, 0);
                const { score: _score, ...chunk } = result;
                return chunk;
            });
        } finally {
            connection.close();
        }
    }
}

export function createVectorStore(name: string, dataPath: string, scoring: VectorSearchScoring = { type: 'cosine' }): VectorStore {
    if (name === 'json') return new JsonVectorStore(path.resolve(dataPath), scoring);
    if (name === 'lancedb') return new LanceDbVectorStore(path.resolve(dataPath));
    throw new Error(`unsupported RAG store: ${name}`);
}

function toLanceRow(chunk: IndexedChunk): LanceChunkRow {
    return {
        id: chunk.id,
        source: chunk.source,
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        titlePath: JSON.stringify(chunk.titlePath ?? []),
        tags: JSON.stringify(chunk.tags ?? []),
        links: JSON.stringify(chunk.links ?? []),
        frontmatter: JSON.stringify(chunk.frontmatter ?? {}),
        vector: chunk.vector as number[]
    };
}

function fromLanceRow(row: Record<string, unknown>, score: number): SearchResult {
    return {
        id: String(row.id),
        source: String(row.source),
        text: String(row.text),
        start: Number(row.start),
        end: Number(row.end),
        titlePath: parseStringArray(row.titlePath),
        tags: parseStringArray(row.tags),
        links: parseStringArray(row.links),
        frontmatter: parseRecord(row.frontmatter),
        vector: [],
        score
    };
}

function parseStringArray(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
}

function parseRecord(value: unknown): Record<string, string | string[]> {
    if (typeof value !== 'string') return {};
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, string | string[]>
        : {};
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
