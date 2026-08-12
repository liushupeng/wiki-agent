import fs from 'node:fs/promises';
import path from 'node:path';
import { clearLine, cursorTo } from 'node:readline';
import '../../src/env.js';
import { iterateSourceDocumentsFromRoots } from '../../src/rag/documentLoader.js';
import { createEmbedder } from '../../src/rag/embeddings.js';
import { CachedEmbedder } from '../../src/rag/embeddingCache.js';
import { runIndexPipeline, type IndexPipelineProgress } from '../../src/rag/indexPipeline.js';
import { getIndexPaths, loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
import { writeIndexManifest } from '../../src/rag/indexRuntime.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { createVectorStore } from '../../src/rag/vectorStore.js';
import { getSourceConfigIdentity } from '../../src/evaluation/experiments.js';
import { indexKnowledgeUsage, parseIndexKnowledgeCommand } from '../../src/rag/indexCli.js';

/**
 * RAG 索引入口。
 *
 * 用法：
 * - npm run index:knowledge
 * - npm run index:knowledge -- -- --profile tf-v1
 * - npm run index:knowledge -- -- --profile tf-v1 --variant raw-only
 *
 * 不带参数或传入 --help 时只打印帮助，不读取来源、不构建索引。实际构建必须显式传入
 * --profile；省略 --variant 时构建该 profile 的全部 variants。
 */
async function main() {
    const command = parseIndexKnowledgeCommand(process.argv.slice(2));
    if (command.action === 'help') {
        console.log(indexKnowledgeUsage());
        return;
    }
    const arguments_ = command.args;
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, arguments_.profileId);
    const variants = arguments_.variantId
        ? [resolveRagIndexVariant(profile, arguments_.variantId)]
        : profile.variants;

    for (const variant of variants) {
        await buildVariant(profile, variant, config.indexDirectory);
    }
}

async function buildVariant(
    profile: ReturnType<typeof resolveRagIndexProfile>,
    variant: ReturnType<typeof resolveRagIndexVariant>,
    indexDirectory: string
) {
    const startedAt = performance.now();
    const paths = getIndexPaths(profile, variant, indexDirectory);
    const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: variant.sourceConfigPath });
    const sourceConfig = await getSourceConfigIdentity(variant.sourceConfigPath);
    const documents = iterateSourceDocumentsFromRoots(sourceRoots);
    const sourceLabel = sourceRoots.map(sourceRoot => `${sourceRoot.prefix}=${sourceRoot.root}`).join(', ');
    const progress = createProgressReporter(startedAt);
    const baseEmbedder = createEmbedder(profile.embedder);
    const embedder = profile.embedder.type === 'transformers-js'
        ? new CachedEmbedder(baseEmbedder, path.resolve('var/cache/embeddings', profile.id))
        : baseEmbedder;

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
            batchSize: profile.embedder.type === 'transformers-js' ? profile.embedder.batchSize : undefined,
            onProgress: progress.update
        });
        await writeIndexManifest(profile, variant, paths, embedder.identity, {
            sourceConfig,
            documentCount: stats.documentCount,
            chunkCount: stats.chunkCount,
            chunkFingerprint: stats.chunkFingerprint
        });
    } finally {
        progress.stop();
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const indexBytes = await pathSize(paths.dataPath);
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
        `  Variant:       ${variant.id}`,
        `  Source config: ${sourceConfig.path}`,
        `  Source hash:   ${sourceConfig.fingerprint}`,
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

async function pathSize(target: string): Promise<number> {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return stat.size;
    const entries = await fs.readdir(target, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => pathSize(`${target}/${entry.name}`))))
        .reduce((sum, value) => sum + value, 0);
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
