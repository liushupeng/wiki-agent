import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import '../../src/env.js';
import { chunkDocument } from '../../src/rag/chunker.js';
import { iterateSourceDocumentsFromRoots } from '../../src/rag/documentLoader.js';
import { createEmbedder } from '../../src/rag/embeddings.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
import { TransformersJsReranker } from '../../src/rag/reranker.js';
import { loadRetrievalProfilesConfig, resolveRetrievalProfile } from '../../src/rag/retrievalProfiles.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { LanceDbVectorStore } from '../../src/rag/vectorStore.js';

const execFileAsync = promisify(execFile);
const BENCHMARK_RESULT_PREFIX = 'RAG_BENCHMARK_RESULT=';

async function runSmokeCheck() {
    const indexes = await loadRagIndexesConfig();
    const denseProfile = resolveRagIndexProfile(indexes, process.argv[2] ?? 'bge-m3-v1');
    if (denseProfile.embedder.type !== 'transformers-js') {
        throw new Error(`profile ${denseProfile.id} is not a Transformers.js embedding profile`);
    }
    const retrieval = resolveRetrievalProfile(
        await loadRetrievalProfilesConfig(),
        process.argv[3] ?? 'hybrid-bge-m3-metadata-source-aggregate-v1'
    );
    if (retrieval.mode !== 'hybrid' || !retrieval.reranker) {
        throw new Error(`retrieval profile ${retrieval.id} has no reranker`);
    }

    const started = performance.now();
    const embedder = createEmbedder(denseProfile.embedder);
    const embeddingStarted = performance.now();
    const vectors = await embedder.embedBatch?.([
        'Agentic RAG 的证据状态有哪些？',
        'BM25 与稠密向量混合召回'
    ]) ?? [];
    const embeddingMs = performance.now() - embeddingStarted;
    validateVectors(vectors, denseProfile.embedder.dimensions);

    const reranker = new TransformersJsReranker(retrieval.reranker);
    const rerankStarted = performance.now();
    const scores = await reranker.score('Agentic RAG 的证据状态有哪些？', [
        '证据充分性分为 insufficient、partial 和 sufficient。',
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
    const texts = ['证据充分性分为 insufficient、partial 和 sufficient。', 'Linux 系统调用通过软中断进入内核。'];
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

type BenchmarkOptions = {
    profileId: string;
    variantId: string;
    sampleCount: number;
    batches: number[];
    dtypes: string[];
    devices: Array<'cpu' | 'webgpu'>;
};

type BenchmarkWorkerOptions = {
    profileId: string;
    sampleFile: string;
    batchSize: number;
    dtype: string;
    device: 'cpu' | 'webgpu';
};

type BenchmarkResult = {
    status: 'ok';
    dtype: string;
    device: string;
    batchSize: number;
    samples: number;
    warmupMs: number;
    benchmarkMs: number;
    chunksPerSecond: number;
    batchP50Ms: number;
    batchP95Ms: number;
    peakRssMiB: number;
    estimatedFullIndexHours: number;
};

async function runBenchmark(options: BenchmarkOptions): Promise<void> {
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, options.profileId);
    if (profile.embedder.type !== 'transformers-js') {
        throw new Error(`profile ${profile.id} is not a Transformers.js embedding profile`);
    }
    const variant = resolveRagIndexVariant(profile, options.variantId);
    const samples = await collectBenchmarkSamples(profile, variant.sourceConfigPath, options.sampleCount);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-rag-benchmark-'));
    const sampleFile = path.join(temporaryDirectory, 'samples.json');
    await fs.writeFile(sampleFile, JSON.stringify(samples), 'utf-8');
    const combinations = options.devices.flatMap(device =>
        options.dtypes.flatMap(dtype =>
            options.batches.map(batchSize => ({ device, dtype, batchSize }))
        )
    );
    const results: Array<BenchmarkResult | {
        status: 'failed';
        dtype: string;
        device: string;
        batchSize: number;
        error: string;
    }> = [];
    try {
        console.log(`[benchmark] 固定样本 ${samples.length} 个；参数组合 ${combinations.length} 组；每组使用独立进程。`);
        for (const combination of combinations) {
            console.log(`[benchmark] device=${combination.device}, dtype=${combination.dtype}, batch=${combination.batchSize}`);
            try {
                const { stdout } = await execFileAsync(process.execPath, [
                    '--import', 'tsx',
                    fileURLToPath(import.meta.url),
                    '--benchmark-worker',
                    '--profile', profile.id,
                    '--sample-file', sampleFile,
                    '--batch', String(combination.batchSize),
                    '--dtype', combination.dtype,
                    '--device', combination.device
                ], {
                    cwd: process.cwd(),
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 30 * 60 * 1000
                });
                const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith(BENCHMARK_RESULT_PREFIX));
                if (!resultLine) throw new Error(`worker did not return benchmark result:\n${stdout.trim()}`);
                results.push(JSON.parse(resultLine.slice(BENCHMARK_RESULT_PREFIX.length)) as BenchmarkResult);
            } catch (error: any) {
                results.push({
                    status: 'failed',
                    ...combination,
                    error: compactError(error?.stderr || error?.message || String(error))
                });
            }
        }
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
    console.table(results.map(result => result.status === 'ok'
        ? {
            status: result.status,
            device: result.device,
            dtype: result.dtype,
            batch: result.batchSize,
            samples: result.samples,
            chunksPerSecond: result.chunksPerSecond,
            p50Ms: result.batchP50Ms,
            p95Ms: result.batchP95Ms,
            peakRssMiB: result.peakRssMiB,
            estimatedHours: result.estimatedFullIndexHours
        }
        : {
            status: result.status,
            device: result.device,
            dtype: result.dtype,
            batch: result.batchSize,
            error: result.error
        }));
}

async function collectBenchmarkSamples(
    profile: ReturnType<typeof resolveRagIndexProfile>,
    sourceConfigPath: string,
    requestedCount: number
): Promise<string[]> {
    const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: sourceConfigPath });
    const texts: string[] = [];
    for await (const document of iterateSourceDocumentsFromRoots(sourceRoots)) {
        for (const chunk of chunkDocument(document, profile.chunkSize, profile.overlap)) {
            texts.push(chunk.text);
        }
    }
    if (texts.length === 0) throw new Error('benchmark source produced no chunks');
    const count = Math.min(requestedCount, texts.length);
    return Array.from({ length: count }, (_, index) => {
        const sourceIndex = Math.min(texts.length - 1, Math.floor(index * texts.length / count));
        return texts[sourceIndex]!;
    });
}

async function runBenchmarkWorker(options: BenchmarkWorkerOptions): Promise<void> {
    if (options.device === 'webgpu' && !(globalThis as any).navigator?.gpu) {
        throw new Error('WebGPU is not available in this Node.js runtime');
    }
    const transformers = await import('@huggingface/transformers');
    transformers.env.allowRemoteModels = false;
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, options.profileId);
    if (profile.embedder.type !== 'transformers-js') {
        throw new Error(`profile ${profile.id} is not a Transformers.js embedding profile`);
    }
    const samples = JSON.parse(await fs.readFile(options.sampleFile, 'utf-8')) as string[];
    const embedder = createEmbedder({
        ...profile.embedder,
        dtype: options.dtype,
        device: options.device,
        batchSize: options.batchSize
    });
    const warmupStarted = performance.now();
    const warmup = await embedder.embedBatch!(samples.slice(0, Math.min(options.batchSize, samples.length)));
    validateBenchmarkVectors(warmup, profile.embedder.dimensions);
    const warmupMs = performance.now() - warmupStarted;
    const latencies: number[] = [];
    const benchmarkStarted = performance.now();
    for (let offset = 0; offset < samples.length; offset += options.batchSize) {
        const batchStarted = performance.now();
        const vectors = await embedder.embedBatch!(samples.slice(offset, offset + options.batchSize));
        validateBenchmarkVectors(vectors, profile.embedder.dimensions);
        latencies.push(performance.now() - batchStarted);
    }
    const benchmarkMs = performance.now() - benchmarkStarted;
    const chunksPerSecond = samples.length / (benchmarkMs / 1000);
    const result: BenchmarkResult = {
        status: 'ok',
        dtype: options.dtype,
        device: options.device,
        batchSize: options.batchSize,
        samples: samples.length,
        warmupMs: rounded(warmupMs),
        benchmarkMs: rounded(benchmarkMs),
        chunksPerSecond: rounded(chunksPerSecond),
        batchP50Ms: rounded(percentile(latencies, 0.5)),
        batchP95Ms: rounded(percentile(latencies, 0.95)),
        peakRssMiB: rounded(process.resourceUsage().maxRSS / 1024),
        estimatedFullIndexHours: rounded(47_093 / chunksPerSecond / 3600)
    };
    console.log(`${BENCHMARK_RESULT_PREFIX}${JSON.stringify(result)}`);
}

function validateBenchmarkVectors(vectors: unknown[], dimensions: number): void {
    if (vectors.length === 0) throw new Error('benchmark returned no vectors');
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) {
            throw new Error(`benchmark requires finite ${dimensions}-dimension vectors`);
        }
    }
}

function percentile(values: number[], quantile: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}

function rounded(value: number): number {
    return Number(value.toFixed(2));
}

function compactError(value: string): string {
    return value.trim().replace(/\s+/g, ' ').slice(0, 240);
}

function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
    return {
        profileId: readOption(args, '--profile') ?? 'bge-m3-v1',
        variantId: readOption(args, '--variant') ?? 'raw-only',
        sampleCount: readPositiveInteger(readOption(args, '--samples') ?? '64', '--samples'),
        batches: readList(args, '--batches', '4,8,16').map(value => readPositiveInteger(value, '--batches')),
        dtypes: readList(args, '--dtypes', 'q4'),
        devices: readList(args, '--devices', 'cpu').map(value => {
            if (value !== 'cpu' && value !== 'webgpu') throw new Error(`--devices only supports cpu or webgpu, received ${value}`);
            return value;
        })
    };
}

function parseBenchmarkWorkerOptions(args: string[]): BenchmarkWorkerOptions {
    const sampleFile = readOption(args, '--sample-file');
    if (!sampleFile) throw new Error('--sample-file is required for benchmark worker');
    const device = readOption(args, '--device');
    if (device !== 'cpu' && device !== 'webgpu') throw new Error('--device must be cpu or webgpu');
    return {
        profileId: readOption(args, '--profile') ?? 'bge-m3-v1',
        sampleFile,
        batchSize: readPositiveInteger(readOption(args, '--batch') ?? '', '--batch'),
        dtype: readOption(args, '--dtype') ?? 'q4',
        device
    };
}

function readOption(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
}

function readList(args: string[], name: string, fallback: string): string[] {
    const optionIndex = args.indexOf(name);
    const following = optionIndex === -1 ? [] : args.slice(optionIndex + 1);
    const nextOptionIndex = following.findIndex(value => value.startsWith('--'));
    const rawValues = optionIndex === -1
        ? [fallback]
        : nextOptionIndex === -1 ? following : following.slice(0, nextOptionIndex);
    const values = rawValues.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
    if (values.length === 0) throw new Error(`${name} requires at least one value`);
    return values;
}

function readPositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function usage(): string {
    return [
        'usage:',
        '  npm run check:rag-models',
        '  npm run check:rag-models -- -- --benchmark [options]',
        '',
        'benchmark options:',
        '  --profile <id>       default: bge-m3-v1',
        '  --variant <id>       default: raw-only',
        '  --samples <n>        default: 64',
        '  --batches <list>     default: 4,8,16',
        '  --dtypes <list>      default: q4',
        '  --devices <list>     default: cpu',
        '',
        'example:',
        '  npm run check:rag-models -- -- --benchmark --samples 256 --batches 4,8,16 --dtypes q4,int8 --devices cpu,webgpu'
    ].join('\n');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log(usage());
    } else if (args.includes('--benchmark-worker')) {
        await runBenchmarkWorker(parseBenchmarkWorkerOptions(args));
    } else if (args.includes('--benchmark')) {
        await runBenchmark(parseBenchmarkOptions(args));
    } else {
        await runSmokeCheck();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
