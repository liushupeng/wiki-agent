import { Vector } from './types.js';

export interface Embedder {
    readonly name: string;
    embed(text: string): Promise<Vector> | Vector;
    embedBatch?(texts: string[]): Promise<Vector[]> | Vector[];
}

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
    return Array.from(text.toLowerCase().matchAll(TOKEN_PATTERN), match => match[0])
        .filter(token => token.length > 1);
}

export function embedText(text: string): Vector {
    const tokens = tokenize(text);
    const counts: Vector = {};

    for (const token of tokens) {
        counts[token] = (counts[token] ?? 0) + 1;
    }

    const norm = Math.sqrt(Object.values(counts).reduce((sum, value) => sum + value * value, 0)) || 1;
    for (const key of Object.keys(counts)) {
        counts[key] = counts[key] / norm;
    }

    return counts;
}

/**
 * 默认的本地词频向量实现。
 *
 * 它不依赖外部模型，适合测试和理解 RAG 流程；生产实验可以新增
 * OpenAIEmbedder、LocalModelEmbedder 等实现，并通过 pipeline 注入。
 */
export class TfEmbedder implements Embedder {
    readonly name = 'tf';

    embed(text: string): Vector {
        return embedText(text);
    }

    embedBatch(texts: string[]): Vector[] {
        return texts.map(text => this.embed(text));
    }
}

export function createEmbedderFromEnv(embedderName = process.env.RAG_EMBEDDER ?? 'tf'): Embedder {
    const normalized = embedderName.toLowerCase();
    if (normalized === 'tf') {
        return new TfEmbedder();
    }

    throw new Error(`unsupported RAG_EMBEDDER: ${embedderName}`);
}
