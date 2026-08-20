import { IndexRuntime, openActiveIndex } from './indexRuntime.js';
import { SearchResult, TextChunk } from './types.js';
import { tokenizeForBm25 } from './embeddings.js';
import {
    HybridRetrievalProfile,
    RerankerProfile,
    RetrievalProfile,
    loadRetrievalProfilesConfig,
    resolveRetrievalProfile
} from './retrievalProfiles.js';
import { Reranker, TransformersJsReranker } from './reranker.js';
import { CachedReranker } from './rerankerCache.js';
import { RetrievalCandidateCache } from './retrievalCandidateCache.js';
import { CacheStats, diffCacheStats, readCacheStats } from './cacheStats.js';

export type CandidateHit = TextChunk & {
    sparseRank?: number;
    sparseScore?: number;
    denseRank?: number;
    denseScore?: number;
    fusionScore: number;
    chunkRerankScore?: number;
    chunkRankingScore?: number;
};

export type Evidence = TextChunk & {
    chunkIds: string[];
    anchorId: string;
    fusionScore: number;
    chunkRerankScore?: number;
    chunkRankingScore?: number;
    evidenceRerankScore?: number;
    evidenceRankingScore?: number;
};

export type RetrievalRun = {
    profile: string;
    query: string;
    sparseCandidates: CandidateHit[];
    denseCandidates: CandidateHit[];
    fusedCandidates: CandidateHit[];
    rerankedCandidates: CandidateHit[];
    sourceLocalCandidates: CandidateHit[];
    anchorCandidates: CandidateHit[];
    assembledEvidences: Evidence[];
    rerankedEvidences: Evidence[];
    evidences: Evidence[];
    elapsedMs: {
        sparse: number;
        dense: number;
        candidateCache: number;
        fusion: number;
        chunkRerank: number;
        sourceLocal: number;
        evidenceAssembly: number;
        evidenceRerank: number;
        total: number;
    };
    diagnostics: {
        candidateCounts: {
            sparse: number;
            dense: number;
            fusion: number;
            chunkRerank: number;
            sourceLocalRerankDocuments: number;
            sourceLocal: number;
            anchors: number;
            evidenceAssembly: number;
            evidenceRerank: number;
            final: number;
        };
        cache: {
            candidates: CacheStats;
            reranker: CacheStats;
        };
    };
};

export interface Retriever {
    readonly profile: RetrievalProfile;
    retrieve(query: string, options?: { topK?: number; candidateLimit?: number }): Promise<RetrievalRun>;
}

export async function openRetriever(
    retrievalProfileId?: string,
    variantId?: string,
    dependencies: { reranker?: Reranker } = {}
): Promise<Retriever> {
    const config = await loadRetrievalProfilesConfig();
    const profile = resolveRetrievalProfile(config, retrievalProfileId);
    if (profile.mode === 'single') {
        const index = await openActiveIndex(profile.indexProfile, variantId);
        const reranker = dependencies.reranker ?? createConfiguredReranker(profile.reranker);
        return createSingleRetriever(profile, index, reranker);
    }
    const [sparse, dense] = await Promise.all([
        openActiveIndex(profile.sparseProfile, variantId),
        openActiveIndex(profile.denseProfile, variantId)
    ]);
    validateHybridIndexes(sparse, dense);
    const reranker = dependencies.reranker ?? createConfiguredReranker(profile.reranker);
    return createHybridRetriever(profile, sparse, dense, reranker);
}

function createConfiguredReranker(profile?: RerankerProfile): Reranker | undefined {
    if (!profile) return undefined;
    const reranker = new TransformersJsReranker(profile);
    return profile.scoreCacheDir
        ? new CachedReranker(reranker, profile, profile.scoreCacheDir)
        : reranker;
}

export function reciprocalRankFusion(
    sparse: SearchResult[],
    dense: SearchResult[],
    rrfK = 60,
    limit = 100
): CandidateHit[] {
    const merged = new Map<string, CandidateHit>();
    const add = (items: SearchResult[], kind: 'sparse' | 'dense') => {
        items.forEach((item, index) => {
            const rank = index + 1;
            const existing = merged.get(item.id) ?? {
                ...withoutVector(item),
                fusionScore: 0
            };
            existing.fusionScore += 1 / (rrfK + rank);
            if (kind === 'sparse') {
                existing.sparseRank = rank;
                existing.sparseScore = item.score;
            } else {
                existing.denseRank = rank;
                existing.denseScore = item.score;
            }
            merged.set(item.id, existing);
        });
    };
    add(sparse, 'sparse');
    add(dense, 'dense');
    return [...merged.values()]
        .sort((left, right) => right.fusionScore - left.fusionScore || left.id.localeCompare(right.id))
        .slice(0, limit);
}

export function limitPerSource<T extends { source: string }>(items: T[], maxPerSource: number, limit: number): T[] {
    const counts = new Map<string, number>();
    const selected: T[] = [];
    for (const item of items) {
        const key = normalizeSource(item.source);
        const count = counts.get(key) ?? 0;
        if (count >= maxPerSource) continue;
        counts.set(key, count + 1);
        selected.push(item);
        if (selected.length >= limit) break;
    }
    return selected;
}

export function linearScoreFusion(priorScores: number[], rerankerScores: number[], rerankerWeight: number): number[] {
    if (priorScores.length !== rerankerScores.length) throw new Error('score fusion inputs must have equal lengths');
    if (!Number.isFinite(rerankerWeight) || rerankerWeight < 0 || rerankerWeight > 1) {
        throw new Error('rerankerWeight must be between 0 and 1');
    }
    const normalizedPrior = minMaxNormalize(priorScores);
    const normalizedReranker = minMaxNormalize(rerankerScores);
    return normalizedPrior.map((prior, index) =>
        (1 - rerankerWeight) * prior + rerankerWeight * normalizedReranker[index]!
    );
}

export function formatRerankDocument(
    item: Pick<TextChunk, 'source' | 'text' | 'titlePath' | 'tags' | 'frontmatter'>,
    mode: 'text' | 'metadata-prefixed' = 'text'
): string {
    if (mode === 'text') return item.text;
    const metadata = [
        `source: ${item.source}`,
        ...(item.titlePath?.length ? [`title: ${item.titlePath.join(' > ')}`] : []),
        ...(item.tags?.length ? [`tags: ${item.tags.join(', ')}`] : []),
        ...(readFrontmatterText(item, 'knowledgeVersion') ? [`version: ${readFrontmatterText(item, 'knowledgeVersion')}`] : []),
        ...(readFrontmatterText(item, 'knowledgeAuthority') ? [`authority: ${readFrontmatterText(item, 'knowledgeAuthority')}`] : []),
        ...(readFrontmatterText(item, 'knowledgeQuality') ? [`quality: ${readFrontmatterText(item, 'knowledgeQuality')}`] : []),
        ...(readFrontmatterText(item, 'knowledgeConsistency') ? [`consistency: ${readFrontmatterText(item, 'knowledgeConsistency')}`] : [])
    ];
    return `${metadata.join('\n')}\n\n${item.text}`;
}

export function governanceRankingPrior(item: Pick<TextChunk, 'frontmatter'>): number {
    const authority = readFrontmatterText(item, 'knowledgeAuthority');
    const quality = Number(readFrontmatterText(item, 'knowledgeQuality'));
    const consistency = readFrontmatterText(item, 'knowledgeConsistency');
    const authorityPrior = authority === 'high' ? 0.04 : authority === 'low' ? -0.04 : 0;
    const qualityPrior = Number.isFinite(quality) ? (quality - 0.5) * 0.06 : 0;
    const consistencyPrior = consistency === 'conflicted' ? -0.03 : consistency === 'conditional' ? -0.01 : 0;
    return authorityPrior + qualityPrior + consistencyPrior;
}

function readFrontmatterText(item: Pick<TextChunk, 'frontmatter'>, key: string): string | undefined {
    const value = item.frontmatter?.[key];
    return typeof value === 'string' ? value : value?.join(', ');
}

export function selectLexicalCandidates(query: string, chunks: TextChunk[], limit: number): TextChunk[] {
    const queryTerms = new Set(tokenizeForBm25(query));
    const score = (chunk: TextChunk): number => {
        const documentTerms = new Set(tokenizeForBm25(formatRerankDocument(chunk, 'metadata-prefixed')));
        let matched = 0;
        for (const term of queryTerms) if (documentTerms.has(term)) matched += 1;
        return queryTerms.size ? matched / queryTerms.size : 0;
    };
    return chunks
        .map(chunk => ({ chunk, score: score(chunk) }))
        .sort((left, right) => right.score - left.score || left.chunk.start - right.chunk.start || left.chunk.id.localeCompare(right.chunk.id))
        .slice(0, limit)
        .map(item => item.chunk);
}

export function includeGlobalSourceCandidate(
    lexicalCandidates: TextChunk[],
    globalCandidate?: TextChunk
): TextChunk[] {
    if (!globalCandidate || lexicalCandidates.some(candidate => candidate.id === globalCandidate.id)) {
        return lexicalCandidates;
    }
    return [...lexicalCandidates, globalCandidate];
}

export function preserveSourceRanking(
    localCandidates: CandidateHit[],
    globallyRankedCandidates: CandidateHit[]
): CandidateHit[] {
    const bestBySource = new Map<string, CandidateHit>();
    for (const candidate of globallyRankedCandidates) {
        const key = normalizeSource(candidate.source);
        if (!bestBySource.has(key)) bestBySource.set(key, candidate);
    }
    return localCandidates.map(candidate => {
        const sourceRepresentative = bestBySource.get(normalizeSource(candidate.source));
        return sourceRepresentative
            ? { ...candidate, chunkRankingScore: candidateRankingScore(sourceRepresentative) }
            : candidate;
    }).sort(compareRankedCandidates);
}

function createSingleRetriever(
    profile: RetrievalProfile & { mode: 'single' },
    index: IndexRuntime,
    reranker?: Reranker
): Retriever {
    return {
        profile,
        async retrieve(query, options = {}) {
            const totalStarted = performance.now();
            const rerankerCacheBefore = readCacheStats(reranker);
            const started = performance.now();
            const limit = options.candidateLimit ?? profile.candidateLimit;
            const results = await index.search(query, limit);
            const candidates = results.map((item, rank) => ({
                ...withoutVector(item),
                ...(index.profile.embedder.type === 'bm25'
                    ? { sparseRank: rank + 1, sparseScore: item.score }
                    : { denseRank: rank + 1, denseScore: item.score }),
                fusionScore: item.score
            }));
            const elapsed = performance.now() - started;
            const rerankStarted = performance.now();
            let rerankedCandidates = candidates;
            if (reranker) {
                const scores = await reranker.score(query, candidates.map(item =>
                    formatRerankDocument(item, profile.rerankDocumentMode)
                ));
                rerankedCandidates = candidates
                    .map((item, rank) => {
                        const prior = governanceRankingPrior(item);
                        return {
                            ...item,
                            chunkRerankScore: scores[rank]!,
                            ...(prior === 0 ? {} : { chunkRankingScore: scores[rank]! + prior })
                        };
                    })
                    .sort((left, right) =>
                        (right.chunkRankingScore ?? right.chunkRerankScore!)
                        - (left.chunkRankingScore ?? left.chunkRerankScore!)
                        || right.fusionScore - left.fusionScore
                    );
            }
            const rerankElapsed = performance.now() - rerankStarted;
            const topK = options.topK ?? 5;
            const evidences = rerankedCandidates.slice(0, topK).map(candidateToEvidence);
            return {
                profile: profile.id,
                query,
                sparseCandidates: index.profile.embedder.type === 'bm25' ? candidates : [],
                denseCandidates: index.profile.embedder.type === 'bm25' ? [] : candidates,
                fusedCandidates: candidates,
                rerankedCandidates,
                sourceLocalCandidates: [],
                anchorCandidates: rerankedCandidates,
                assembledEvidences: evidences,
                rerankedEvidences: evidences,
                evidences,
                elapsedMs: {
                    sparse: index.profile.embedder.type === 'bm25' ? elapsed : 0,
                    dense: index.profile.embedder.type === 'bm25' ? 0 : elapsed,
                    candidateCache: 0,
                    fusion: 0,
                    chunkRerank: rerankElapsed,
                    sourceLocal: 0,
                    evidenceAssembly: 0,
                    evidenceRerank: 0,
                    total: performance.now() - totalStarted
                },
                diagnostics: {
                    candidateCounts: {
                        sparse: index.profile.embedder.type === 'bm25' ? candidates.length : 0,
                        dense: index.profile.embedder.type === 'bm25' ? 0 : candidates.length,
                        fusion: candidates.length,
                        chunkRerank: reranker ? candidates.length : 0,
                        sourceLocalRerankDocuments: 0,
                        sourceLocal: 0,
                        anchors: rerankedCandidates.length,
                        evidenceAssembly: evidences.length,
                        evidenceRerank: 0,
                        final: evidences.length
                    },
                    cache: {
                        candidates: { requests: 0, hits: 0, misses: 0 },
                        reranker: diffCacheStats(readCacheStats(reranker), rerankerCacheBefore)
                    }
                }
            };
        }
    };
}

function createHybridRetriever(
    profile: HybridRetrievalProfile,
    sparse: IndexRuntime,
    dense: IndexRuntime,
    reranker?: Reranker
): Retriever {
    const candidateCache = profile.candidateCacheDir
        ? new RetrievalCandidateCache(profile.candidateCacheDir, JSON.stringify({
            sparseProfile: sparse.profile.id,
            denseProfile: dense.profile.id,
            variant: sparse.variant.id,
            sparseIndex: sparse.manifest.profileFingerprint,
            denseIndex: dense.manifest.profileFingerprint,
            sparseChunks: sparse.manifest.chunkFingerprint,
            denseChunks: dense.manifest.chunkFingerprint,
            sparseCreatedAt: sparse.manifest.chunkFingerprint ? undefined : sparse.manifest.createdAt,
            denseCreatedAt: dense.manifest.chunkFingerprint ? undefined : dense.manifest.createdAt
        }))
        : undefined;
    return {
        profile,
        async retrieve(query, options = {}) {
            const totalStarted = performance.now();
            const candidateCacheBefore = readCacheStats(candidateCache);
            const rerankerCacheBefore = readCacheStats(reranker);
            const perRetrieverLimit = options.candidateLimit ?? profile.candidateLimitPerRetriever;
            const retrievalStarted = performance.now();
            let sparseElapsed = 0;
            let denseElapsed = 0;
            const loadCandidates = async () => {
                const [sparseResults, denseResults] = await Promise.all([
                    (async () => {
                        const started = performance.now();
                        const results = await sparse.search(query, perRetrieverLimit);
                        sparseElapsed = performance.now() - started;
                        return results;
                    })(),
                    (async () => {
                        const started = performance.now();
                        const results = await dense.search(query, perRetrieverLimit);
                        denseElapsed = performance.now() - started;
                        return results;
                    })()
                ]);
                return { sparse: sparseResults, dense: denseResults };
            };
            const snapshot = candidateCache
                ? await candidateCache.getOrLoad(query, perRetrieverLimit, loadCandidates)
                : await loadCandidates();
            const sparseRaw = snapshot.sparse;
            const denseRaw = snapshot.dense;
            const retrievalElapsed = performance.now() - retrievalStarted;

            const fusionStarted = performance.now();
            const sparseCandidates = reciprocalRankFusion(sparseRaw, [], profile.rrfK, perRetrieverLimit);
            const denseCandidates = reciprocalRankFusion([], denseRaw, profile.rrfK, perRetrieverLimit);
            const fusedCandidates = reciprocalRankFusion(sparseRaw, denseRaw, profile.rrfK, profile.fusionLimit);
            const fusionElapsed = performance.now() - fusionStarted;

            const chunkStarted = performance.now();
            let rerankedCandidates = fusedCandidates;
            const chunkRerankEnabled = profile.stages?.chunkRerank ?? Boolean(reranker);
            let chunkRerankDocuments = 0;
            if (reranker && chunkRerankEnabled) {
                const input = fusedCandidates.slice(0, profile.chunkRerankLimit ?? fusedCandidates.length);
                chunkRerankDocuments = input.length;
                const scores = await reranker.score(query, input.map(item =>
                    formatRerankDocument(item, profile.rerankDocumentMode)
                ));
                const rankingScores = profile.chunkRerankFusionWeight === undefined
                    ? scores
                    : linearScoreFusion(input.map(item => item.fusionScore), scores, profile.chunkRerankFusionWeight);
                rerankedCandidates = input.map((item, index) => ({
                    ...item,
                    chunkRerankScore: scores[index]!,
                    ...(
                        profile.chunkRerankFusionWeight === undefined && governanceRankingPrior(item) === 0
                            ? {}
                            : { chunkRankingScore: rankingScores[index]! + governanceRankingPrior(item) }
                    )
                })).sort((left, right) =>
                    (right.chunkRankingScore ?? right.chunkRerankScore!)
                    - (left.chunkRankingScore ?? left.chunkRerankScore!)
                    || right.fusionScore - left.fusionScore
                );
            }
            const chunkElapsed = performance.now() - chunkStarted;

            const sourceLocalStarted = performance.now();
            const sourceLocalResult = reranker && profile.sourceLocalSearch
                ? await retrieveSourceLocalCandidates(
                    query,
                    fusedCandidates,
                    rerankedCandidates,
                    sparse,
                    reranker,
                    profile
                )
                : { candidates: [], rerankDocuments: 0 };
            const sourceLocalCandidates = sourceLocalResult.candidates;
            const anchorCandidates = profile.sourceLocalSearch?.anchorMode === 'source-local-only'
                ? sourceLocalCandidates
                : profile.sourceLocalSearch?.anchorMode === 'source-aggregate'
                    ? aggregateSourceCandidates(rerankedCandidates, sourceLocalCandidates)
                    : profile.sourceLocalSearch?.rankingMode === 'source-preserving'
                        ? replaceSourceRepresentatives(rerankedCandidates, sourceLocalCandidates)
                        : mergeRankedCandidates(rerankedCandidates, sourceLocalCandidates);
            const sourceLocalElapsed = performance.now() - sourceLocalStarted;

            const evidenceStarted = performance.now();
            const anchors = anchorCandidates.slice(0, profile.anchorLimit ?? (options.topK ?? 5));
            const evidenceExpandEnabled = profile.stages?.evidenceExpand ?? (profile.contextWindow ?? 0) > 0;
            const assembledEvidences = await assembleEvidenceWindows(
                anchors,
                sparse,
                evidenceExpandEnabled ? profile.contextWindow ?? 0 : 0
            );
            const evidenceAssemblyElapsed = performance.now() - evidenceStarted;
            let rerankedEvidences = assembledEvidences;
            const evidenceRerankEnabled = profile.stages?.evidenceRerank
                ?? Boolean(reranker && evidenceExpandEnabled);
            const evidenceRerankStarted = performance.now();
            if (reranker && evidenceRerankEnabled) {
                const scores = await reranker.score(query, assembledEvidences.map(item =>
                    formatRerankDocument(item, profile.rerankDocumentMode)
                ));
                const priorScores = assembledEvidences.map(item =>
                    item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore
                );
                const rankingScores = profile.evidenceRerankFusionWeight === undefined
                    ? scores
                    : linearScoreFusion(priorScores, scores, profile.evidenceRerankFusionWeight);
                rerankedEvidences = assembledEvidences.map((item, index) => ({
                    ...item,
                    evidenceRerankScore: scores[index]!,
                    ...(
                        profile.evidenceRerankFusionWeight === undefined && governanceRankingPrior(item) === 0
                            ? {}
                            : { evidenceRankingScore: rankingScores[index]! + governanceRankingPrior(item) }
                    )
                })).sort((left, right) =>
                    (right.evidenceRankingScore ?? right.evidenceRerankScore!)
                    - (left.evidenceRankingScore ?? left.evidenceRerankScore!)
                );
            }
            let evidences: Evidence[];
            const sourceLimitEnabled = profile.stages?.sourceLimit ?? Boolean(profile.maxPerSource);
            if (profile.maxPerSource && sourceLimitEnabled) {
                evidences = limitPerSource(rerankedEvidences, profile.maxPerSource, options.topK ?? 5);
            } else {
                evidences = rerankedEvidences.slice(0, options.topK ?? 5);
            }
            const evidenceRerankElapsed = performance.now() - evidenceRerankStarted;

            return {
                profile: profile.id,
                query,
                sparseCandidates,
                denseCandidates,
                fusedCandidates,
                rerankedCandidates,
                sourceLocalCandidates,
                anchorCandidates,
                assembledEvidences,
                rerankedEvidences,
                evidences,
                elapsedMs: {
                    sparse: sparseElapsed,
                    dense: denseElapsed,
                    candidateCache: Math.max(0, retrievalElapsed - Math.max(sparseElapsed, denseElapsed)),
                    fusion: fusionElapsed,
                    chunkRerank: chunkElapsed,
                    sourceLocal: sourceLocalElapsed,
                    evidenceAssembly: evidenceAssemblyElapsed,
                    evidenceRerank: reranker && evidenceRerankEnabled ? evidenceRerankElapsed : 0,
                    total: performance.now() - totalStarted
                },
                diagnostics: {
                    candidateCounts: {
                        sparse: sparseCandidates.length,
                        dense: denseCandidates.length,
                        fusion: fusedCandidates.length,
                        chunkRerank: chunkRerankDocuments,
                        sourceLocalRerankDocuments: sourceLocalResult.rerankDocuments,
                        sourceLocal: sourceLocalCandidates.length,
                        anchors: anchors.length,
                        evidenceAssembly: assembledEvidences.length,
                        evidenceRerank: reranker && evidenceRerankEnabled ? assembledEvidences.length : 0,
                        final: evidences.length
                    },
                    cache: {
                        candidates: diffCacheStats(readCacheStats(candidateCache), candidateCacheBefore),
                        reranker: diffCacheStats(readCacheStats(reranker), rerankerCacheBefore)
                    }
                }
            };
        }
    };
}

async function retrieveSourceLocalCandidates(
    query: string,
    fusedCandidates: CandidateHit[],
    rerankedCandidates: CandidateHit[],
    lookup: Pick<IndexRuntime, 'findBySource'>,
    reranker: Reranker,
    profile: HybridRetrievalProfile
): Promise<{ candidates: CandidateHit[]; rerankDocuments: number }> {
    const options = profile.sourceLocalSearch!;
    const sourceAnchors = new Map<string, CandidateHit>();
    for (const candidate of fusedCandidates) {
        const key = normalizeSource(candidate.source);
        if (!sourceAnchors.has(key)) sourceAnchors.set(key, candidate);
        if (sourceAnchors.size >= options.sourceLimit) break;
    }
    const globalBestBySource = new Map<string, CandidateHit>();
    for (const candidate of rerankedCandidates) {
        const key = normalizeSource(candidate.source);
        if (!globalBestBySource.has(key)) globalBestBySource.set(key, candidate);
    }

    const localInputs = (await Promise.all([...sourceAnchors.entries()].map(async ([sourceKey, anchor]) => {
        const chunks = (await lookup.findBySource(anchor.source)).map(withoutVector);
        return includeGlobalSourceCandidate(
            selectLexicalCandidates(query, chunks, options.candidateLimitPerSource),
            globalBestBySource.get(sourceKey)
        )
            .map(chunk => ({ sourceKey, anchor, chunk }));
    }))).flat();
    if (!localInputs.length) return { candidates: [], rerankDocuments: 0 };

    const scores = await reranker.score(query, localInputs.map(item =>
        formatRerankDocument(item.chunk, profile.rerankDocumentMode)
    ));
    const rankingScores = profile.chunkRerankFusionWeight === undefined
        ? scores
        : linearScoreFusion(localInputs.map(item => item.anchor.fusionScore), scores, profile.chunkRerankFusionWeight);
    const existingById = new Map(fusedCandidates.map(candidate => [candidate.id, candidate]));
    const bySource = new Map<string, CandidateHit[]>();

    localInputs.forEach((input, index) => {
        const existing = existingById.get(input.chunk.id);
        const governancePrior = governanceRankingPrior(existing ?? input.chunk);
        const candidate: CandidateHit = {
            ...(existing ?? input.chunk),
            fusionScore: existing?.fusionScore ?? input.anchor.fusionScore,
            chunkRerankScore: scores[index]!,
            ...(profile.chunkRerankFusionWeight === undefined && governancePrior === 0
                ? {}
                : { chunkRankingScore: rankingScores[index]! + governancePrior })
        };
        const items = bySource.get(input.sourceKey) ?? [];
        items.push(candidate);
        bySource.set(input.sourceKey, items);
    });

    const selected = [...bySource.values()].flatMap(items =>
        items.sort(compareRankedCandidates).slice(0, options.chunksPerSource)
    );
    return {
        candidates: options.rankingMode === 'source-preserving'
            ? preserveSourceRanking(selected, rerankedCandidates)
            : selected.sort(compareRankedCandidates),
        rerankDocuments: localInputs.length
    };
}

function mergeRankedCandidates(primary: CandidateHit[], supplemental: CandidateHit[]): CandidateHit[] {
    const merged = new Map(primary.map(candidate => [candidate.id, candidate]));
    for (const candidate of supplemental) {
        const existing = merged.get(candidate.id);
        if (!existing || compareRankedCandidates(candidate, existing) < 0) merged.set(candidate.id, candidate);
    }
    return [...merged.values()].sort(compareRankedCandidates);
}

export function replaceSourceRepresentatives(
    primary: CandidateHit[],
    replacements: CandidateHit[]
): CandidateHit[] {
    const replacementBySource = new Map<string, CandidateHit>();
    for (const candidate of replacements) {
        const key = normalizeSource(candidate.source);
        if (!replacementBySource.has(key)) replacementBySource.set(key, candidate);
    }
    const replacementIds = new Set([...replacementBySource.values()].map(candidate => candidate.id));
    const insertedSources = new Set<string>();
    const result: CandidateHit[] = [];

    for (const candidate of primary) {
        const sourceKey = normalizeSource(candidate.source);
        const replacement = replacementBySource.get(sourceKey);
        if (replacement && !insertedSources.has(sourceKey)) {
            result.push(replacement);
            insertedSources.add(sourceKey);
            continue;
        }
        if (!replacementIds.has(candidate.id)) result.push(candidate);
    }
    for (const [sourceKey, replacement] of replacementBySource) {
        if (!insertedSources.has(sourceKey)) result.push(replacement);
    }
    return result;
}

export function aggregateSourceCandidates(
    globallyRanked: CandidateHit[],
    sourceLocal: CandidateHit[]
): CandidateHit[] {
    const globalBySource = new Map<string, CandidateHit>();
    for (const candidate of globallyRanked) {
        const key = normalizeSource(candidate.source);
        if (!globalBySource.has(key)) globalBySource.set(key, candidate);
    }
    const localBySource = new Map<string, CandidateHit>();
    for (const candidate of sourceLocal) {
        const key = normalizeSource(candidate.source);
        if (!localBySource.has(key)) localBySource.set(key, candidate);
    }
    const aggregated = [...localBySource.entries()].map(([source, local]) => {
        const global = globalBySource.get(source);
        if (!global) return local;
        globalBySource.delete(source);
        if (global.id === local.id) return local;
        const ordered = [global, local].sort((left, right) => left.start - right.start);
        return {
            ...local,
            id: `${local.source}#aggregate-${global.id}-${local.id}`,
            text: mergeSeparatedChunkText(ordered),
            start: Math.min(global.start, local.start),
            end: Math.max(global.end, local.end)
        };
    });
    return aggregated.sort(compareRankedCandidates);
}

function compareRankedCandidates(left: CandidateHit, right: CandidateHit): number {
    return candidateRankingScore(right) - candidateRankingScore(left)
        || right.fusionScore - left.fusionScore
        || left.id.localeCompare(right.id);
}

function candidateRankingScore(candidate: CandidateHit): number {
    return candidate.chunkRankingScore ?? candidate.chunkRerankScore ?? candidate.fusionScore;
}

async function assembleEvidenceWindows(
    anchors: CandidateHit[],
    lookup: Pick<IndexRuntime, 'findBySource'>,
    radius: number
): Promise<Evidence[]> {
    const bySource = new Map<string, TextChunk[]>();
    const windows: Evidence[] = [];
    const seen = new Set<string>();
    for (const anchor of anchors) {
        let chunks = bySource.get(anchor.source);
        if (!chunks) {
            chunks = (await lookup.findBySource(anchor.source))
                .map(withoutVector)
                .sort((left, right) => left.start - right.start);
            bySource.set(anchor.source, chunks);
        }
        const anchorIndex = chunks.findIndex(item => item.id === anchor.id);
        const selected = anchorIndex < 0
            ? [anchor]
            : chunks.slice(Math.max(0, anchorIndex - radius), anchorIndex + radius + 1);
        const start = Math.min(...selected.map(item => item.start));
        const end = Math.max(...selected.map(item => item.end));
        const key = `${normalizeSource(anchor.source)}:${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push({
            id: `${anchor.source}#evidence-${start}-${end}`,
            source: anchor.source,
            text: mergeChunkText(selected),
            start,
            end,
            titlePath: anchor.titlePath,
            tags: anchor.tags,
            links: anchor.links,
            frontmatter: anchor.frontmatter,
            chunkIds: selected.map(item => item.id),
            anchorId: anchor.id,
            fusionScore: anchor.fusionScore,
            ...(anchor.chunkRerankScore === undefined ? {} : { chunkRerankScore: anchor.chunkRerankScore }),
            ...(anchor.chunkRankingScore === undefined ? {} : { chunkRankingScore: anchor.chunkRankingScore })
        });
    }
    return windows;
}

function mergeChunkText(chunks: TextChunk[]): string {
    const ordered = [...chunks].sort((left, right) => left.start - right.start);
    if (ordered.length === 0) return '';
    let text = ordered[0]!.text;
    let end = ordered[0]!.end;
    for (const chunk of ordered.slice(1)) {
        const overlap = Math.max(0, end - chunk.start);
        text += chunk.text.slice(Math.min(overlap, chunk.text.length));
        end = Math.max(end, chunk.end);
    }
    return text;
}

function mergeSeparatedChunkText(chunks: TextChunk[]): string {
    if (!chunks.length) return '';
    let text = chunks[0]!.text;
    let end = chunks[0]!.end;
    for (const chunk of chunks.slice(1)) {
        const overlap = Math.max(0, end - chunk.start);
        text += overlap > 0
            ? chunk.text.slice(Math.min(overlap, chunk.text.length))
            : `\n\n${chunk.text}`;
        end = Math.max(end, chunk.end);
    }
    return text;
}

function candidateToEvidence(candidate: CandidateHit): Evidence {
    return {
        ...candidate,
        chunkIds: [candidate.id],
        anchorId: candidate.id
    };
}

function withoutVector(result: SearchResult): TextChunk;
function withoutVector(result: TextChunk & { vector?: unknown; score?: unknown }): TextChunk;
function withoutVector(result: TextChunk & { vector?: unknown; score?: unknown }): TextChunk {
    const { vector: _vector, score: _score, ...chunk } = result;
    return chunk;
}

function validateHybridIndexes(sparse: IndexRuntime, dense: IndexRuntime): void {
    if (sparse.variant.id !== dense.variant.id) throw new Error('hybrid indexes must use the same variant');
    if (sparse.manifest.chunkSize !== dense.manifest.chunkSize || sparse.manifest.overlap !== dense.manifest.overlap) {
        throw new Error('hybrid indexes must use identical chunk configuration');
    }
    const sparseSource = sparse.manifest.sourceConfig?.fingerprint;
    const denseSource = dense.manifest.sourceConfig?.fingerprint;
    if (sparseSource && denseSource && sparseSource !== denseSource) {
        throw new Error('hybrid indexes were built from different source configurations');
    }
    const sparseChunks = sparse.manifest.chunkFingerprint;
    const denseChunks = dense.manifest.chunkFingerprint;
    if (sparseChunks && denseChunks && sparseChunks !== denseChunks) {
        throw new Error('hybrid indexes contain different chunk snapshots');
    }
}

function normalizeSource(source: string): string {
    return source.replaceAll('\\', '/').toLowerCase();
}

function minMaxNormalize(scores: number[]): number[] {
    if (scores.length === 0) return [];
    const minimum = Math.min(...scores);
    const maximum = Math.max(...scores);
    if (maximum === minimum) return scores.map(() => 0.5);
    return scores.map(score => (score - minimum) / (maximum - minimum));
}
