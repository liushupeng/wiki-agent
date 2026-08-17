export type CacheStats = {
    requests: number;
    hits: number;
    misses: number;
};

export type CacheStatsProvider = {
    getCacheStats(): CacheStats;
};

export function emptyCacheStats(): CacheStats {
    return { requests: 0, hits: 0, misses: 0 };
}

export function diffCacheStats(after: CacheStats, before: CacheStats): CacheStats {
    return {
        requests: after.requests - before.requests,
        hits: after.hits - before.hits,
        misses: after.misses - before.misses
    };
}

export function readCacheStats(value?: unknown): CacheStats {
    return value && typeof (value as CacheStatsProvider).getCacheStats === 'function'
        ? (value as CacheStatsProvider).getCacheStats()
        : emptyCacheStats();
}
