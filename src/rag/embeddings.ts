import OpenAI from 'openai';
import { EmbeddingProfile } from './indexProfiles.js';
import { SparseVector, Vector } from './types.js';

export interface Embedder {
    readonly name: string;
    readonly identity: EmbeddingIdentity;
    embed(text: string): Promise<Vector> | Vector;
    embedBatch?(texts: string[]): Promise<Vector[]> | Vector[];
}

export type EmbeddingIdentity = {
    type: EmbeddingProfile['type'];
    provider: string;
    model: string;
    revision?: string;
    dtype?: string;
    pooling?: string;
    maxLength?: number;
    dimensions?: number;
    normalization: 'l2' | 'none';
};

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const BM25_TOKEN_PATTERN = /[\p{Script=Han}]+|[\p{Script=Latin}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
    return Array.from(text.toLowerCase().matchAll(TOKEN_PATTERN), match => match[0])
        .filter(token => token.length > 1);
}

export function embedText(text: string): Vector {
    const tokens = tokenize(text);
    const counts: SparseVector = Object.create(null);

    for (const token of tokens) {
        counts[token] = (counts[token] ?? 0) + 1;
    }

    const norm = Math.sqrt(Object.values(counts).reduce((sum, value) => sum + value * value, 0)) || 1;
    for (const key of Object.keys(counts)) {
        counts[key] = counts[key] / norm;
    }

    return counts;
}

export function termFrequencies(text: string): SparseVector {
    const counts: SparseVector = Object.create(null);
    for (const token of tokenizeForBm25(text)) {
        counts[token] = (counts[token] ?? 0) + 1;
    }
    return counts;
}

/**
 * BM25 的中文最小可用分词：中文连续文本拆为二元词，拉丁字母、数字和下划线
 * 仍保留为完整词。它不依赖词典或模型，避免将整句中文视作单个无法匹配的 token。
 */
export function tokenizeForBm25(text: string): string[] {
    const tokens: string[] = [];
    for (const match of text.toLowerCase().matchAll(BM25_TOKEN_PATTERN)) {
        const segment = match[0];
        if (/^\p{Script=Han}+$/u.test(segment)) {
            if (segment.length === 1) {
                tokens.push(segment);
            } else {
                for (let index = 0; index < segment.length - 1; index += 1) {
                    tokens.push(segment.slice(index, index + 2));
                }
            }
        } else if (segment.length > 1) {
            tokens.push(segment);
        }
    }
    return tokens;
}

/**
 * 默认的本地词频向量实现。
 *
 * 它不依赖外部模型，适合测试和理解 RAG 流程；生产实验可以新增
 * OpenAIEmbedder、LocalModelEmbedder 等实现，并通过 pipeline 注入。
 */
export class TfEmbedder implements Embedder {
    readonly name = 'tf';
    readonly identity: EmbeddingIdentity = {
        type: 'tf',
        provider: 'local',
        model: 'term-frequency',
        normalization: 'l2'
    };

    embed(text: string): Vector {
        return embedText(text);
    }

    embedBatch(texts: string[]): Vector[] {
        return texts.map(text => this.embed(text));
    }
}

export class Bm25Embedder implements Embedder {
    readonly name = 'bm25';
    readonly identity: EmbeddingIdentity;

    constructor(profile: Extract<EmbeddingProfile, { type: 'bm25' }>) {
        this.identity = {
            type: 'bm25',
            provider: 'local',
            model: 'okapi-bm25-zh-bigram-v2',
            normalization: 'none'
        };
        this.k1 = profile.k1 ?? 1.2;
        this.b = profile.b ?? 0.75;
    }

    readonly k1: number;
    readonly b: number;

    embed(text: string): SparseVector {
        return termFrequencies(text);
    }

    embedBatch(texts: string[]): SparseVector[] {
        return texts.map(text => this.embed(text));
    }
}

export class OpenAiCompatibleEmbedder implements Embedder {
    readonly name: string;
    readonly identity: EmbeddingIdentity;
    private readonly client: OpenAI;

    constructor(private readonly profile: Extract<EmbeddingProfile, { type: 'openai-compatible' }>) {
        const baseURL = process.env[profile.baseUrlEnv];
        const apiKey = process.env[profile.apiKeyEnv];
        if (!baseURL) throw new Error(`missing embedding endpoint environment variable: ${profile.baseUrlEnv}`);
        if (!apiKey) throw new Error(`missing embedding API key environment variable: ${profile.apiKeyEnv}`);
        this.name = `openai-compatible:${profile.model}`;
        this.identity = {
            type: 'openai-compatible',
            provider: 'openai-compatible',
            model: profile.model,
            dimensions: profile.dimensions,
            normalization: 'l2'
        };
        this.client = new OpenAI({ baseURL, apiKey });
    }

    async embed(text: string): Promise<Vector> {
        return (await this.embedBatch([text]))[0];
    }

    async embedBatch(texts: string[]): Promise<Vector[]> {
        if (texts.length === 0) return [];
        const response = await this.client.embeddings.create({
            model: this.profile.model,
            input: texts,
            dimensions: this.profile.dimensions
        });
        const vectors = response.data
            .sort((left, right) => left.index - right.index)
            .map(item => item.embedding);
        if (vectors.length !== texts.length) {
            throw new Error(`embedding API returned ${vectors.length} vectors for ${texts.length} inputs`);
        }
        if (vectors.some(vector => vector.length !== this.profile.dimensions)) {
            throw new Error(`embedding API returned a vector dimension different from ${this.profile.dimensions}`);
        }
        return vectors;
    }
}

type FeatureExtractionPipeline = (
    texts: string | string[],
    options: Record<string, unknown>
) => Promise<{ tolist(): unknown }>;

const localPipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

export class TransformersJsEmbedder implements Embedder {
    readonly name: string;
    readonly identity: EmbeddingIdentity;

    constructor(private readonly profile: Extract<EmbeddingProfile, { type: 'transformers-js' }>) {
        this.name = `transformers-js:${profile.model}`;
        this.identity = {
            type: 'transformers-js',
            provider: 'transformers-js',
            model: profile.model,
            ...(profile.revision ? { revision: profile.revision } : {}),
            ...(profile.dtype ? { dtype: profile.dtype } : {}),
            pooling: profile.pooling ?? 'cls',
            maxLength: profile.maxLength ?? 512,
            dimensions: profile.dimensions,
            normalization: 'l2'
        };
    }

    async embed(text: string): Promise<Vector> {
        return (await this.embedBatch([text]))[0]!;
    }

    async embedBatch(texts: string[]): Promise<Vector[]> {
        if (texts.length === 0) return [];
        const pipeline = await this.getPipeline();
        const batchSize = this.profile.batchSize ?? 8;
        const vectors: number[][] = [];
        for (let offset = 0; offset < texts.length; offset += batchSize) {
            const batch = texts.slice(offset, offset + batchSize);
            const tensor = await pipeline(batch, {
                pooling: this.profile.pooling ?? 'cls',
                normalize: true,
                truncation: true,
                max_length: this.profile.maxLength ?? 512
            });
            const values = tensor.tolist();
            if (!Array.isArray(values)) throw new Error('Transformers.js embedding output is not an array');
            const rows = values as number[][];
            if (rows.length !== batch.length || rows.some(row => !Array.isArray(row) || row.length !== this.profile.dimensions)) {
                throw new Error(`Transformers.js embedding output must contain ${batch.length} vectors of ${this.profile.dimensions} dimensions`);
            }
            if (rows.some(row => row.some(value => !Number.isFinite(value)))) {
                throw new Error('Transformers.js embedding output contains NaN or Infinity');
            }
            vectors.push(...rows);
        }
        return vectors;
    }

    private async getPipeline(): Promise<FeatureExtractionPipeline> {
        const key = JSON.stringify({
            model: this.profile.model,
            revision: this.profile.revision,
            dtype: this.profile.dtype,
            device: this.profile.device,
            cacheDir: this.profile.cacheDir
        });
        let loading = localPipelineCache.get(key);
        if (!loading) {
            loading = (async () => {
                const transformers = await import('@huggingface/transformers');
                if (this.profile.cacheDir) transformers.env.cacheDir = this.profile.cacheDir;
                return await transformers.pipeline('feature-extraction', this.profile.model, {
                    ...(this.profile.revision ? { revision: this.profile.revision } : {}),
                    ...(this.profile.dtype ? { dtype: this.profile.dtype as any } : {}),
                    ...(this.profile.device ? { device: this.profile.device as any } : {})
                }) as unknown as FeatureExtractionPipeline;
            })();
            localPipelineCache.set(key, loading);
        }
        try {
            return await loading;
        } catch (error) {
            localPipelineCache.delete(key);
            throw error;
        }
    }
}

export function createEmbedder(profile: EmbeddingProfile): Embedder {
    if (profile.type === 'tf') return new TfEmbedder();
    if (profile.type === 'bm25') return new Bm25Embedder(profile);
    if (profile.type === 'openai-compatible') return new OpenAiCompatibleEmbedder(profile);
    return new TransformersJsEmbedder(profile);
}
