import { IndexRuntime, openActiveIndex } from './indexRuntime.js';
import { SearchResult, TextChunk } from './types.js';
import {
    HybridRetrievalProfile,
    RetrievalProfile,
    loadRetrievalProfilesConfig,
    resolveRetrievalProfile
} from './retrievalProfiles.js';
import { Reranker, TransformersJsReranker } from './reranker.js';

export type CandidateHit = TextChunk & {
    sparseRank?: number;
    sparseScore?: number;
    denseRank?: number;
    denseScore?: number;
    fusionScore: number;
    chunkRerankScore?: number;
};

export type Evidence = TextChunk & {
    chunkIds: string[];
    anchorId: string;
    fusionScore: number;
    chunkRerankScore?: number;
    evidenceRerankScore?: number;
};

export type RetrievalRun = {
    profile: string;
    query: string;
    sparseCandidates: CandidateHit[];
    denseCandidates: CandidateHit[];
    fusedCandidates: CandidateHit[];
    rerankedCandidates: CandidateHit[];
    evidences: Evidence[];
    elapsedMs: {
        sparse: number;
        dense: number;
        fusion: number;
        chunkRerank: number;
        evidenceRerank: number;
        total: number;
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
        const reranker = dependencies.reranker ?? (profile.reranker ? new TransformersJsReranker(profile.reranker) : undefined);
        return createSingleRetriever(profile, index, reranker);
    }
    const [sparse, dense] = await Promise.all([
        openActiveIndex(profile.sparseProfile, variantId),
        openActiveIndex(profile.denseProfile, variantId)
    ]);
    validateHybridIndexes(sparse, dense);
    const reranker = dependencies.reranker ?? (profile.reranker ? new TransformersJsReranker(profile.reranker) : undefined);
    return createHybridRetriever(profile, sparse, dense, reranker);
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

function createSingleRetriever(
    profile: RetrievalProfile & { mode: 'single' },
    index: IndexRuntime,
    reranker?: Reranker
): Retriever {
    return {
        profile,
        async retrieve(query, options = {}) {
            const totalStarted = performance.now();
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
                const scores = await reranker.score(query, candidates.map(item => item.text));
                rerankedCandidates = candidates
                    .map((item, rank) => ({ ...item, chunkRerankScore: scores[rank]! }))
                    .sort((left, right) => right.chunkRerankScore! - left.chunkRerankScore! || right.fusionScore - left.fusionScore);
            }
            const rerankElapsed = performance.now() - rerankStarted;
            const topK = options.topK ?? 5;
            return {
                profile: profile.id,
                query,
                sparseCandidates: index.profile.embedder.type === 'bm25' ? candidates : [],
                denseCandidates: index.profile.embedder.type === 'bm25' ? [] : candidates,
                fusedCandidates: candidates,
                rerankedCandidates,
                evidences: rerankedCandidates.slice(0, topK).map(candidateToEvidence),
                elapsedMs: {
                    sparse: index.profile.embedder.type === 'bm25' ? elapsed : 0,
                    dense: index.profile.embedder.type === 'bm25' ? 0 : elapsed,
                    fusion: 0,
                    chunkRerank: rerankElapsed,
                    evidenceRerank: 0,
                    total: performance.now() - totalStarted
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
    return {
        profile,
        async retrieve(query, options = {}) {
            const totalStarted = performance.now();
            const perRetrieverLimit = options.candidateLimit ?? profile.candidateLimitPerRetriever;
            const sparseStarted = performance.now();
            const sparsePromise = sparse.search(query, perRetrieverLimit);
            const denseStarted = performance.now();
            const densePromise = dense.search(query, perRetrieverLimit);
            const [sparseRaw, denseRaw] = await Promise.all([sparsePromise, densePromise]);
            const sparseElapsed = performance.now() - sparseStarted;
            const denseElapsed = performance.now() - denseStarted;

            const fusionStarted = performance.now();
            const sparseCandidates = reciprocalRankFusion(sparseRaw, [], profile.rrfK, perRetrieverLimit);
            const denseCandidates = reciprocalRankFusion([], denseRaw, profile.rrfK, perRetrieverLimit);
            const fusedCandidates = reciprocalRankFusion(sparseRaw, denseRaw, profile.rrfK, profile.fusionLimit);
            const fusionElapsed = performance.now() - fusionStarted;

            const chunkStarted = performance.now();
            let rerankedCandidates = fusedCandidates;
            if (reranker) {
                const input = fusedCandidates.slice(0, profile.chunkRerankLimit ?? fusedCandidates.length);
                const scores = await reranker.score(query, input.map(item => item.text));
                rerankedCandidates = input
                    .map((item, index) => ({ ...item, chunkRerankScore: scores[index]! }))
                    .sort((left, right) => right.chunkRerankScore! - left.chunkRerankScore! || right.fusionScore - left.fusionScore);
            }
            const chunkElapsed = performance.now() - chunkStarted;

            const evidenceStarted = performance.now();
            const anchors = rerankedCandidates.slice(0, profile.anchorLimit ?? (options.topK ?? 5));
            let evidences = await assembleEvidenceWindows(anchors, sparse, profile.contextWindow ?? 0);
            if (reranker && (profile.contextWindow ?? 0) > 0) {
                const scores = await reranker.score(query, evidences.map(item => item.text));
                evidences = evidences
                    .map((item, index) => ({ ...item, evidenceRerankScore: scores[index]! }))
                    .sort((left, right) => right.evidenceRerankScore! - left.evidenceRerankScore!);
            }
            if (profile.maxPerSource) {
                evidences = limitPerSource(evidences, profile.maxPerSource, options.topK ?? 5);
            } else {
                evidences = evidences.slice(0, options.topK ?? 5);
            }
            const evidenceElapsed = performance.now() - evidenceStarted;

            return {
                profile: profile.id,
                query,
                sparseCandidates,
                denseCandidates,
                fusedCandidates,
                rerankedCandidates,
                evidences,
                elapsedMs: {
                    sparse: sparseElapsed,
                    dense: denseElapsed,
                    fusion: fusionElapsed,
                    chunkRerank: chunkElapsed,
                    evidenceRerank: evidenceElapsed,
                    total: performance.now() - totalStarted
                }
            };
        }
    };
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
            ...(anchor.chunkRerankScore === undefined ? {} : { chunkRerankScore: anchor.chunkRerankScore })
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
