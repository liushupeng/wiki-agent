import fs from 'node:fs/promises';
import path from 'path';
import { clearLine, cursorTo } from 'node:readline';
import { iterateSourceDocumentsFromRoots } from '../../src/rag/documentLoader.js';
import { createEmbedderFromEnv } from '../../src/rag/embeddings.js';
import { runIndexPipeline, type IndexPipelineProgress } from '../../src/rag/indexPipeline.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { createVectorStoreFromEnv } from '../../src/rag/vectorStore.js';

/**
 * RAG 索引入口。
 *
 * 用法：
 * - npm run index:notes
 * - npm run index:notes -- <notesDir>
 * - npm run index:notes -- <notesDir> <indexPath>
 *
 * 默认读取 config/knowledge.sources.jsonc。
 * 可用 KNOWLEDGE_SOURCES_CONFIG_PATH 指向其他数据源配置文件。
 * CLI 显式传入 <notesDir> 时按单根目录索引，方便临时实验。
 * 默认写入 var/knowledge/index.json。
 * RAG_STORE、RAG_EMBEDDER 和 RAG_CHUNKER 控制实验方案；当前内置 json/tf/auto。
 * 这个文件只负责解析 CLI/env 配置并启动索引 pipeline；新增文件切分策略、
 * embedding 实现或向量库时，优先扩展 rag/ 下的 adapter，而不是改这里。
 */
async function main() {
    const startedAt = performance.now();
    const cliSourceDir = process.argv[2];
    const sourceDir = path.resolve(cliSourceDir ?? 'notes');
    const outputFile = path.resolve(process.argv[3] ?? process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
    const chunkSize = Number(process.env.RAG_CHUNK_SIZE ?? 900);
    const overlap = Number(process.env.RAG_CHUNK_OVERLAP ?? 120);
    const chunker = (process.env.RAG_CHUNKER ?? 'auto').toLowerCase();
    if (chunker !== 'auto') {
        throw new Error(`unsupported RAG_CHUNKER: ${chunker}`);
    }

    const sourceRoots = cliSourceDir
        ? undefined
        : await getKnowledgeSourceRoots();
    const documents = sourceRoots
        ? iterateSourceDocumentsFromRoots(sourceRoots)
        : undefined;
    const sourceLabel = sourceRoots
        ? sourceRoots.map(sourceRoot => `${sourceRoot.prefix}=${sourceRoot.root}`).join(', ')
        : sourceDir;
    const progress = createProgressReporter(startedAt);

    progress.start();
    let stats: Awaited<ReturnType<typeof runIndexPipeline>>;
    try {
        stats = await runIndexPipeline({
            sourceDir,
            documents,
            chunkSize,
            overlap,
            embedder: createEmbedderFromEnv(),
            vectorStore: createVectorStoreFromEnv({ filePath: outputFile }),
            onProgress: progress.update
        });
    } finally {
        progress.stop();
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const indexBytes = (await fs.stat(outputFile)).size;
    const peakMemoryBytes = process.resourceUsage().maxRSS * 1024;
    const chunksPerSecond = elapsedSeconds > 0 ? stats.chunkCount / elapsedSeconds : 0;

    console.log([
        '',
        'Knowledge index complete',
        `  Sources:       ${sourceLabel}`,
        `  Documents:     ${stats.documentCount.toLocaleString()}`,
        `  Chunks:        ${stats.chunkCount.toLocaleString()}`,
        `  Chunk config:  size=${stats.chunkSize}, overlap=${stats.overlap}`,
        `  Embedder:      ${stats.embedder}`,
        `  Store:         ${stats.store}`,
        `  Output:        ${outputFile}`,
        `  Index size:    ${formatBytes(indexBytes)}`,
        `  Elapsed:       ${elapsedSeconds.toFixed(2)} s`,
        `  Throughput:    ${chunksPerSecond.toFixed(1)} chunks/s`,
        `  Peak memory:   ${formatBytes(peakMemoryBytes)}`
    ].join('\n'));
}

function createProgressReporter(startedAt: number) {
    const interactive = Boolean(process.stdout.isTTY);
    const outputIntervalMs = interactive ? 250 : 5000;
    let lastOutputAt = 0;
    let active = false;

    const writeInteractiveLine = (message: string) => {
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write(message);
    };

    return {
        start() {
            active = true;
            const message = 'Indexing knowledge sources...';
            if (interactive) {
                writeInteractiveLine(message);
            } else {
                console.log(message);
            }
        },
        update(progress: IndexPipelineProgress) {
            if (!active) return;
            const now = performance.now();
            if (now - lastOutputAt < outputIntervalMs) return;
            lastOutputAt = now;

            const elapsedSeconds = (now - startedAt) / 1000;
            const source = truncateStart(progress.currentSource, 60);
            const message = [
                'Indexing...',
                `${progress.documentCount.toLocaleString()} documents`,
                `${progress.chunkCount.toLocaleString()} chunks`,
                `${elapsedSeconds.toFixed(1)} s`,
                source
            ].join(' | ');

            if (interactive) {
                writeInteractiveLine(message);
            } else {
                console.log(message);
            }
        },
        stop() {
            if (!active) return;
            if (interactive) {
                writeInteractiveLine('');
                process.stdout.write('\n');
            }
            active = false;
        }
    };
}

function truncateStart(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `...${value.slice(-(maxLength - 3))}`;
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
