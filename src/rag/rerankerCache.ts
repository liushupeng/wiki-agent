import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RerankerProfile } from './retrievalProfiles.js';
import { Reranker } from './reranker.js';
import { CacheStats } from './cacheStats.js';

type ScoreMiss = {
    document: string;
    file: string;
    indexes: number[];
};

export class CachedReranker implements Reranker {
    readonly name: string;
    private readonly identity: string;
    private readonly stats: CacheStats = { requests: 0, hits: 0, misses: 0 };

    constructor(
        private readonly inner: Reranker,
        profile: RerankerProfile,
        private readonly cacheDirectory: string
    ) {
        this.name = `cached:${inner.name}`;
        this.identity = JSON.stringify({
            model: profile.model,
            revision: profile.revision ?? 'main',
            dtype: profile.dtype,
            device: profile.device ?? 'cpu',
            maxLength: profile.maxLength
        });
    }

    async score(query: string, documents: string[]): Promise<number[]> {
        this.stats.requests += documents.length;
        const results: Array<number | undefined> = new Array(documents.length);
        const missesByFile = new Map<string, ScoreMiss>();
        await Promise.all(documents.map(async (document, index) => {
            const file = this.cachePath(query, document);
            const cached = await readScore(file);
            if (cached !== undefined) {
                this.stats.hits += 1;
                results[index] = cached;
                return;
            }
            const miss = missesByFile.get(file);
            if (miss) miss.indexes.push(index);
            else missesByFile.set(file, { document, file, indexes: [index] });
        }));

        const misses = [...missesByFile.values()];
        this.stats.misses += misses.reduce((sum, miss) => sum + miss.indexes.length, 0);
        if (misses.length > 0) {
            const generated = await this.inner.score(query, misses.map(miss => miss.document));
            if (generated.length !== misses.length) {
                throw new Error(`reranker cache received ${generated.length} scores for ${misses.length} misses`);
            }
            await Promise.all(misses.map(async (miss, index) => {
                const score = generated[index]!;
                if (!Number.isFinite(score)) throw new Error('reranker cache cannot store a non-finite score');
                for (const resultIndex of miss.indexes) results[resultIndex] = score;
                await writeScore(miss.file, score);
            }));
        }

        return results as number[];
    }

    getCacheStats(): CacheStats {
        return { ...this.stats };
    }

    private cachePath(query: string, document: string): string {
        const hash = createHash('sha256')
            .update(this.identity)
            .update('\0')
            .update(query)
            .update('\0')
            .update(document)
            .digest('hex');
        return path.resolve(this.cacheDirectory, hash.slice(0, 2), `${hash}.score`);
    }
}

async function readScore(file: string): Promise<number | undefined> {
    try {
        const value = Number(await fs.readFile(file, 'utf-8'));
        return Number.isFinite(value) ? value : undefined;
    } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
}

async function writeScore(file: string, score: number): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${score}\n`, { encoding: 'utf-8', flag: 'wx' });
        await commitScore(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function commitScore(temporary: string, file: string): Promise<void> {
    const retryDelaysMs = [0, 25, 100, 250];
    let lastError: unknown;
    for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
            await fs.rename(temporary, file);
            return;
        } catch (error: any) {
            lastError = error;
            if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
            try {
                if (await readScore(file) !== undefined) return;
            } catch (readError: any) {
                if (!['EPERM', 'EACCES'].includes(readError?.code)) throw readError;
            }
        }
    }
    throw lastError;
}
