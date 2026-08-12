import { TraceAttributes } from '../trace/telemetry.js';

export type RetrievalTraceDocument = {
    source: string;
    id?: string;
    line?: number;
    score?: number;
    sparseRank?: number;
    sparseScore?: number;
    denseRank?: number;
    denseScore?: number;
    fusionScore?: number;
    chunkRerankScore?: number;
    evidenceRerankScore?: number;
};

export type RetrievalDecision = {
    query: string;
    mode: 'vector' | 'grep';
    topK: number;
    candidateLimit: number;
    profile?: string;
    variant?: string;
    wikiFirst: boolean;
    candidates: RetrievalTraceDocument[];
    matches: RetrievalTraceDocument[];
    elapsedMs: number;
};

export function retrievalSpanTraceAttributes(decision: Omit<RetrievalDecision, 'candidates' | 'matches' | 'elapsedMs'>): TraceAttributes {
    return {
        'gen_ai.operation.name': 'retrieval',
        'gen_ai.data_source.id': decision.profile && decision.variant
            ? `${decision.profile}/${decision.variant}`
            : 'wiki-agent',
        'wiki_agent.rag.mode': decision.mode,
        ...(decision.profile ? { 'wiki_agent.rag.profile': decision.profile } : {}),
        ...(decision.variant ? { 'wiki_agent.rag.variant': decision.variant } : {})
    };
}

export function retrievalRequestTraceAttributes(decision: Omit<RetrievalDecision, 'candidates' | 'matches' | 'elapsedMs'>): TraceAttributes {
    return {
        'gen_ai.retrieval.query.text': decision.query,
        'gen_ai.request.top_k': decision.topK,
        'wiki_agent.rag.candidate_limit': decision.candidateLimit,
        'wiki_agent.rag.wiki_first': decision.wikiFirst
    };
}

export function retrievalCandidatesTraceAttributes(decision: RetrievalDecision): TraceAttributes {
    return {
        'wiki_agent.rag.candidate_documents': JSON.stringify(toTraceDocuments(decision.candidates))
    };
}

export function retrievalResultTraceAttributes(decision: RetrievalDecision): TraceAttributes {
    return {
        'gen_ai.retrieval.documents': JSON.stringify(toTraceDocuments(decision.matches)),
        'wiki_agent.rag.match_count': decision.matches.length,
        'wiki_agent.rag.latency_ms': Math.round(decision.elapsedMs)
    };
}

export function retrievalStageTraceAttributes(matches: RetrievalTraceDocument[]): TraceAttributes {
    return {
        'gen_ai.retrieval.documents': JSON.stringify(matches.map((match, index) => ({
            rank: index + 1,
            id: match.id ?? `${match.source}:${match.line ?? index + 1}`,
            source: match.source,
            ...(match.score === undefined ? {} : { score: rounded(match.score) }),
            ...(match.sparseRank === undefined ? {} : { sparseRank: match.sparseRank }),
            ...(match.sparseScore === undefined ? {} : { sparseScore: rounded(match.sparseScore) }),
            ...(match.denseRank === undefined ? {} : { denseRank: match.denseRank }),
            ...(match.denseScore === undefined ? {} : { denseScore: rounded(match.denseScore) }),
            ...(match.fusionScore === undefined ? {} : { fusionScore: rounded(match.fusionScore) }),
            ...(match.chunkRerankScore === undefined ? {} : { chunkRerankScore: rounded(match.chunkRerankScore) }),
            ...(match.evidenceRerankScore === undefined ? {} : { evidenceRerankScore: rounded(match.evidenceRerankScore) })
        })))
    };
}

function toTraceDocuments(matches: RetrievalTraceDocument[]): Array<{ rank: number; id: string; source: string; score: number }> {
    return matches.map((match, index) => ({
        rank: index + 1,
        id: match.id ?? `${match.source}:${match.line ?? index + 1}`,
        source: match.source,
        score: Number((match.score ?? 0).toFixed(6))
    }));
}

function rounded(value: number): number {
    return Number(value.toFixed(6));
}
