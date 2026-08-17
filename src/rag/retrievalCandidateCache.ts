import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SearchResult } from './types.js';
import { CacheStats } from './cacheStats.js';

export type RetrievalCandidateSnapshot = {
    sparse: SearchResult[];
    dense: SearchResult[];
};

export class RetrievalCandidateCache {
    private readonly stats: CacheStats = { requests: 0, hits: 0, misses: 0 };

    constructor(
        private readonly cacheDirectory: string,
        private readonly indexIdentity: string
    ) {}

    async getOrLoad(
        query: string,
        candidateLimit: number,
        load: () => Promise<RetrievalCandidateSnapshot>
    ): Promise<RetrievalCandidateSnapshot> {
        this.stats.requests += 1;
        const file = this.cachePath(query, candidateLimit);
        const cached = await readSnapshot(file);
        if (cached) {
            this.stats.hits += 1;
            return cached;
        }
        this.stats.misses += 1;
        const snapshot = stripVectors(await load());
        await writeSnapshot(file, snapshot);
        return snapshot;
    }

    getCacheStats(): CacheStats {
        return { ...this.stats };
    }

    private cachePath(query: string, candidateLimit: number): string {
        const hash = createHash('sha256')
            .update(this.indexIdentity)
            .update('\0')
            .update(String(candidateLimit))
            .update('\0')
            .update(query)
            .digest('hex');
        return path.resolve(this.cacheDirectory, hash.slice(0, 2), `${hash}.json`);
    }
}

function stripVectors(snapshot: RetrievalCandidateSnapshot): RetrievalCandidateSnapshot {
    const strip = (result: SearchResult): SearchResult => ({ ...result, vector: [] });
    return {
        sparse: snapshot.sparse.map(strip),
        dense: snapshot.dense.map(strip)
    };
}

async function readSnapshot(file: string): Promise<RetrievalCandidateSnapshot | undefined> {
    try {
        const value = JSON.parse(await fs.readFile(file, 'utf-8')) as RetrievalCandidateSnapshot;
        if (!Array.isArray(value?.sparse) || !Array.isArray(value?.dense)) return undefined;
        return value;
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

async function writeSnapshot(file: string, snapshot: RetrievalCandidateSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf-8', flag: 'wx' });
        try {
            await fs.rename(temporary, file);
        } catch (error: any) {
            if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code) || !(await readSnapshot(file))) throw error;
        }
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}
