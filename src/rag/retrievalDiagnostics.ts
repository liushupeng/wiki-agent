import { TraceAttributes } from '../trace/telemetry.js';

export type RetrievalTraceDocument = {
    source: string;
    id?: string;
    line?: number;
    score?: number;
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

export function retrievalStartTraceAttributes(decision: Omit<RetrievalDecision, 'candidates' | 'matches' | 'elapsedMs'>): TraceAttributes {
    return {
        'gen_ai.operation.name': 'retrieval',
        'gen_ai.data_source.id': decision.profile && decision.variant
            ? `${decision.profile}/${decision.variant}`
            : 'wiki-agent',
        'gen_ai.request.top_k': decision.topK,
        'gen_ai.retrieval.query.text': decision.query,
        'wiki_agent.rag.mode': decision.mode,
        'wiki_agent.rag.candidate_limit': decision.candidateLimit,
        'wiki_agent.rag.wiki_first': decision.wikiFirst,
        ...(decision.profile ? { 'wiki_agent.rag.profile': decision.profile } : {}),
        ...(decision.variant ? { 'wiki_agent.rag.variant': decision.variant } : {})
    };
}

export function retrievalEndTraceAttributes(decision: RetrievalDecision): TraceAttributes {
    return {
        'wiki_agent.rag.candidate_documents': JSON.stringify(toTraceDocuments(decision.candidates)),
        'gen_ai.retrieval.documents': JSON.stringify(toTraceDocuments(decision.matches)),
        'wiki_agent.rag.match_count': decision.matches.length,
        'wiki_agent.rag.sources': JSON.stringify(Array.from(new Set(decision.matches.map(match => match.source)))),
        'wiki_agent.rag.latency_ms': Math.round(decision.elapsedMs)
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
