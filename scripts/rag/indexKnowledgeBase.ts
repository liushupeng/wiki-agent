import fs from 'node:fs/promises';
import { clearLine, cursorTo } from 'node:readline';
import '../../src/env.js';
import { iterateSourceDocumentsFromRoots } from '../../src/rag/documentLoader.js';
import { createEmbedder } from '../../src/rag/embeddings.js';
import { runIndexPipeline, type IndexPipelineProgress } from '../../src/rag/indexPipeline.js';
import { getIndexPaths, loadRagIndexesConfig, resolveRagIndexProfile } from '../../src/rag/indexProfiles.js';
import { writeIndexManifest } from '../../src/rag/indexRuntime.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { createVectorStore } from '../../src/rag/vectorStore.js';

/**
 * RAG 索引入口。
 *
 * 用法：
 * - npm run index:notes
 * - npm run index:notes -- --profile tf-v1
 *
 * 默认读取 config/knowledge.sources.jsonc。
 * 可用 KNOWLEDGE_SOURCES_CONFIG_PATH 指向其他数据源配置文件。
 * RAG_INDEXES_CONFIG_PATH 指向 profile 配置；每个 profile 写入独立目录。
 */
async function main() {
    const startedAt = performance.now();
    const profileId = readProfileId(process.argv.slice(2));
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, profileId);
    const paths = getIndexPaths(profile, config.indexDirectory);
    const sourceRoots = await getKnowledgeSourceRoots();
    const documents = iterateSourceDocumentsFromRoots(sourceRoots);
    const sourceLabel = sourceRoots.map(sourceRoot => `${sourceRoot.prefix}=${sourceRoot.root}`).join(', ');
    const progress = createProgressReporter(startedAt);
    const embedder = createEmbedder(profile.embedder);

    progress.start();
    let stats: Awaited<ReturnType<typeof runIndexPipeline>>;
    try {
        stats = await runIndexPipeline({
            sourceDir: process.cwd(),
            documents,
            chunkSize: profile.chunkSize,
            overlap: profile.overlap,
            embedder,
            vectorStore: createVectorStore(profile.store, paths.dataPath),
            onProgress: progress.update
        });
        await writeIndexManifest(profile, paths, embedder.identity);
    } finally {
        progress.stop();
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const indexBytes = (await fs.stat(paths.dataPath)).size;
    const peakMemoryBytes = process.resourceUsage().maxRSS * 1024;
    const chunksPerSecond = elapsedSeconds > 0 ? stats.chunkCount / elapsedSeconds : 0;

    console.log([
        '',
        'Knowledge index complete',
        `  Sources:       ${sourceLabel}`,
        `  Documents:     ${stats.documentCount.toLocaleString()}`,
        `  Chunks:        ${stats.chunkCount.toLocaleString()}`,
        `  Chunk config:  size=${stats.chunkSize}, overlap=${stats.overlap}`,
        `  Profile:       ${profile.id}`,
        `  Embedder:      ${stats.embedder}`,
        `  Store:         ${stats.store}`,
        `  Output:        ${paths.dataPath}`,
        `  Manifest:      ${paths.manifestPath}`,
        `  Index size:    ${formatBytes(indexBytes)}`,
        `  Elapsed:       ${elapsedSeconds.toFixed(2)} s`,
        `  Throughput:    ${chunksPerSecond.toFixed(1)} chunks/s`,
        `  Peak memory:   ${formatBytes(peakMemoryBytes)}`
    ].join('\n'));
}

function readProfileId(args: string[]): string | undefined {
    if (args.length === 0) return undefined;
    if (args.length === 2 && args[0] === '--profile' && args[1]) return args[1];
    throw new Error('usage: npm run index:notes -- [--profile <profileId>]');
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
