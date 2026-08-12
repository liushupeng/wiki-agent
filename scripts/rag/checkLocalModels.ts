import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../../src/env.js';
import { createEmbedder } from '../../src/rag/embeddings.js';
import { loadRagIndexesConfig, resolveRagIndexProfile } from '../../src/rag/indexProfiles.js';
import { TransformersJsReranker } from '../../src/rag/reranker.js';
import { loadRetrievalProfilesConfig, resolveRetrievalProfile } from '../../src/rag/retrievalProfiles.js';
import { LanceDbVectorStore } from '../../src/rag/vectorStore.js';

async function main() {
    const indexes = await loadRagIndexesConfig();
    const denseProfile = resolveRagIndexProfile(indexes, process.argv[2] ?? 'bge-m3-v1');
    if (denseProfile.embedder.type !== 'transformers-js') {
        throw new Error(`profile ${denseProfile.id} is not a Transformers.js embedding profile`);
    }
    const retrieval = resolveRetrievalProfile(
        await loadRetrievalProfilesConfig(),
        process.argv[3] ?? 'hybrid-bge-m3-rerank-v1'
    );
    if (retrieval.mode !== 'hybrid' || !retrieval.reranker) {
        throw new Error(`retrieval profile ${retrieval.id} has no reranker`);
    }

    const started = performance.now();
    const embedder = createEmbedder(denseProfile.embedder);
    const embeddingStarted = performance.now();
    const vectors = await embedder.embedBatch?.([
        '投资体系的三根支柱是什么？',
        'BM25 与稠密向量混合召回'
    ]) ?? [];
    const embeddingMs = performance.now() - embeddingStarted;
    validateVectors(vectors, denseProfile.embedder.dimensions);

    const reranker = new TransformersJsReranker(retrieval.reranker);
    const rerankStarted = performance.now();
    const scores = await reranker.score('投资体系的三根支柱是什么？', [
        '投资体系由投资理念、能力圈和风险控制构成。',
        'Linux 系统调用通过软中断进入内核。'
    ]);
    const rerankMs = performance.now() - rerankStarted;
    if (scores.length !== 2 || scores.some(score => !Number.isFinite(score))) {
        throw new Error('reranker smoke test returned invalid logits');
    }

    const databasePath = path.resolve('var', 'checks', `lancedb-${randomUUID()}`);
    const store = new LanceDbVectorStore(databasePath);
    try {
        await store.replaceChunks(toChunks(vectors), { chunkSize: 32, overlap: 0 });
        const matches = await store.search(vectors[0]!, 2);
        if (matches[0]?.id !== 'smoke#1') throw new Error('LanceDB cosine smoke test returned an unexpected first match');
    } finally {
        await fs.rm(databasePath, { recursive: true, force: true });
    }

    console.log(JSON.stringify({
        status: 'ok',
        embedding: {
            model: embedder.identity,
            vectors: vectors.length,
            elapsedMs: Math.round(embeddingMs)
        },
        reranker: {
            model: reranker.name,
            logits: scores.map(score => Number(score.toFixed(6))),
            elapsedMs: Math.round(rerankMs)
        },
        peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
        totalMs: Math.round(performance.now() - started)
    }, null, 2));
}

async function* toChunks(vectors: number[][]) {
    const texts = ['投资体系由投资理念、能力圈和风险控制构成。', 'Linux 系统调用通过软中断进入内核。'];
    for (let index = 0; index < vectors.length; index += 1) {
        yield {
            id: `smoke#${index + 1}`,
            source: `smoke-${index + 1}.md`,
            text: texts[index]!,
            start: 0,
            end: texts[index]!.length,
            vector: vectors[index]!
        };
    }
}

function validateVectors(vectors: unknown[], dimensions: number): asserts vectors is number[][] {
    if (vectors.length !== 2) throw new Error(`embedding smoke test expected 2 vectors, received ${vectors.length}`);
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) {
            throw new Error(`embedding smoke test requires finite ${dimensions}-dimension vectors`);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
