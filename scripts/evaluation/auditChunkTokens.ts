import fs from 'node:fs/promises';
import path from 'node:path';
import { AutoTokenizer, env as transformersEnv } from '@huggingface/transformers';
import '../../src/env.js';
import { chunkDocument } from '../../src/rag/chunker.js';
import { iterateSourceDocumentsFromRoots } from '../../src/rag/documentLoader.js';
import { loadRagIndexesConfig, resolveRagIndexProfile, resolveRagIndexVariant } from '../../src/rag/indexProfiles.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';
import { SourceDocument } from '../../src/rag/types.js';

const CANDIDATES = [
    { chunkSize: 900, overlap: 120 },
    { chunkSize: 600, overlap: 90 },
    { chunkSize: 450, overlap: 60 }
];

async function main(): Promise<void> {
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, process.argv[2] ?? 'bge-m3-v1');
    if (profile.embedder.type !== 'transformers-js') {
        throw new Error(`profile ${profile.id} does not use a transformers-js tokenizer`);
    }
    const variant = resolveRagIndexVariant(profile, process.argv[3] ?? config.activeVariant);
    const sourceRoots = await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: variant.sourceConfigPath });
    const documents: SourceDocument[] = [];
    for await (const document of iterateSourceDocumentsFromRoots(sourceRoots)) documents.push(document);
    if (profile.embedder.cacheDir) transformersEnv.cacheDir = profile.embedder.cacheDir;
    const tokenizer = await AutoTokenizer.from_pretrained(profile.embedder.model, {
        revision: profile.embedder.revision,
    });
    const maxLength = profile.embedder.maxLength ?? 512;
    const candidates = CANDIDATES.map(candidate => {
        const tokenCounts = documents.flatMap(document =>
            chunkDocument(document, candidate.chunkSize, candidate.overlap)
                .map(chunk => tokenCount(tokenizer(chunk.text, { truncation: false }).input_ids))
        );
        const overflowCount = tokenCounts.filter(count => count > maxLength).length;
        return {
            ...candidate,
            chunkCount: tokenCounts.length,
            maxTokens: Math.max(...tokenCounts, 0),
            p95Tokens: percentile(tokenCounts, 0.95),
            overflowCount,
            overflowRate: tokenCounts.length ? overflowCount / tokenCounts.length : 0
        };
    });
    const report = {
        createdAt: new Date().toISOString(),
        profile: profile.id,
        variant: variant.id,
        model: profile.embedder.model,
        maxLength,
        documentCount: documents.length,
        candidates
    };
    const outputDirectory = path.resolve('var/evals/chunk-audit', report.createdAt.replace(/[:.]/g, '-'));
    await fs.mkdir(outputDirectory, { recursive: true });
    const reportPath = path.join(outputDirectory, 'report.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    for (const candidate of candidates) {
        console.log(
            `size=${candidate.chunkSize}/${candidate.overlap} chunks=${candidate.chunkCount} `
            + `p95=${candidate.p95Tokens} max=${candidate.maxTokens} `
            + `overflow=${candidate.overflowCount} (${(candidate.overflowRate * 100).toFixed(2)}%)`
        );
    }
    console.log(`report=${reportPath}`);
}

function tokenCount(inputIds: unknown): number {
    if (Array.isArray(inputIds)) return inputIds.flat(Infinity).length;
    if (typeof inputIds === 'object' && inputIds !== null && 'data' in inputIds) {
        const data = (inputIds as { data?: { length?: number } }).data;
        if (typeof data?.length === 'number') return data.length;
    }
    throw new Error('unsupported tokenizer output');
}

function percentile(values: number[], ratio: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
