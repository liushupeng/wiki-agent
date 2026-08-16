import path from 'node:path';
import { GrepNotesMatch, grepMatchesToSearchResults, grepNotes } from './grep.js';
import { prioritizeWikiMatches } from './ranking.js';
import { KnowledgeSourceRoot, sourceWithPrefix } from './sourceRoots.js';
import { SearchResult, TextChunk } from './types.js';
import { IndexRuntime } from './indexRuntime.js';
import { Retriever } from './retrievalPipeline.js';

export type EvalQuestion = {
    id?: string;
    category?: string;
    queryType?: string;
    primaryStage?: 'candidate-retrieval' | 'rerank' | 'evidence' | 'agent';
    difficulty?: 'easy' | 'medium' | 'hard';
    question: string;
    grepTerms?: string[];
    expectedSource?: string;
    expectedSources?: string[];
    expectedTerms?: string[];
};

export type EvalQuestionResult = {
    id?: string;
    category?: string;
    question: string;
    passed: boolean;
    strictPassed: boolean;
    sourceHit: boolean;
    expectedSources?: string[];
    termScore: number;
    sourceTermScore: number;
    topSources: Array<{ source: string; score: number }>;
    candidateSourceHit?: boolean;
    hitAt1?: boolean;
    reciprocalRank?: number;
    stageRanks?: Partial<Record<RetrievalStageName, number | null>>;
    stageDiagnostics?: Partial<Record<RetrievalStageName, {
        sourceRank: number | null;
        contentRank: number | null;
        bestTermCoverage: number;
    }>>;
};

export type RetrievalStageName =
    | 'sparse'
    | 'dense'
    | 'fusion'
    | 'chunkRerank'
    | 'sourceLocal'
    | 'anchorSelection'
    | 'evidenceAssembly'
    | 'evidenceRerank'
    | 'final';

export type EvalRetrievalStages = Partial<Record<RetrievalStageName, SearchResult[]>>;

export type EvalSummary = {
    status: 'success';
    retriever: string;
    passed: number;
    strictPassed: number;
    total: number;
    accuracy: number;
    strictAccuracy: number;
    metrics?: RetrievalMetrics;
    results: EvalQuestionResult[];
};

export type EvalComparisonSummary = {
    status: 'success';
    mode: 'both';
    vector: EvalSummary;
    grep: EvalSummary;
};

export type EvalRetriever = {
    name: string;
    search(question: EvalQuestion, topK: number): Promise<SearchResult[]>;
    candidateSearch?(question: EvalQuestion, candidateK: number): Promise<SearchResult[]>;
    rerank?(candidates: SearchResult[], topK: number): SearchResult[];
    evaluate?(question: EvalQuestion, candidateK: number, topK: number): Promise<{
        candidates: SearchResult[];
        matches: SearchResult[];
        stages?: EvalRetrievalStages;
    }>;
};

export type EvalProgress = {
    completed: number;
    total: number;
    question: Required<Pick<EvalQuestion, 'id' | 'category' | 'queryType' | 'primaryStage' | 'difficulty'>> & EvalQuestion;
};

export type EvalRetrievalDecision = {
    question: Required<Pick<EvalQuestion, 'id' | 'category' | 'queryType' | 'primaryStage' | 'difficulty'>> & EvalQuestion;
    retriever: string;
    topK: number;
    candidateLimit: number;
    candidates: SearchResult[];
    matches: SearchResult[];
    stages?: EvalRetrievalStages;
    result: EvalQuestionResult;
    startedAt: Date;
    elapsedMs: number;
};

export type EvalRetrieverOptions = {
    wikiFirst: boolean;
};

export function normalizeEvalQuestion(value: EvalQuestion, index = 0): Required<Pick<EvalQuestion, 'id' | 'category' | 'queryType' | 'primaryStage' | 'difficulty'>> & EvalQuestion {
    return {
        ...value,
        id: value.id ?? `question-${index + 1}`,
        category: value.category ?? 'uncategorized',
        queryType: value.queryType ?? 'fact-retrieval',
        primaryStage: value.primaryStage ?? 'candidate-retrieval',
        difficulty: value.difficulty ?? 'medium'
    };
}

export function validateEvaluationQuestionBank(questions: EvalQuestion[]): void {
    const ids = new Set<string>();
    for (const [index, question] of questions.entries()) {
        if (!question.id?.trim() || !question.category?.trim() || !question.queryType?.trim() || !question.primaryStage || !question.difficulty) {
            throw new Error(`evaluation question ${index + 1} requires id, category, queryType, primaryStage, and difficulty`);
        }
        if (ids.has(question.id)) throw new Error(`duplicate evaluation question id: ${question.id}`);
        ids.add(question.id);
    }
}

/**
 * 创建向量检索评测器。wikiFirst 为 true 时，先扩大候选范围，
 * 再将维护型 wiki 结果排在 raw 资料之前。
 */
export function createVectorEvalRetriever(
    vectorStore: Pick<IndexRuntime, 'search'>,
    options: EvalRetrieverOptions
): EvalRetriever {
    return {
        name: 'vector',
        candidateSearch: (item, candidateK) => vectorStore.search(item.question, candidateK),
        rerank: (matches, topK) => options.wikiFirst ? prioritizeWikiMatches(matches, topK) : matches.slice(0, topK),
        async search(item, topK) {
            const candidateLimit = getCandidateLimit(topK, options);
            const matches = await vectorStore.search(item.question, candidateLimit);
            return options.wikiFirst ? prioritizeWikiMatches(matches, topK) : matches;
        }
    };
}

export function createPipelineEvalRetriever(retriever: Retriever): EvalRetriever {
    const toResults = <T extends TextChunk>(items: T[], score: (item: T) => number): SearchResult[] =>
        items.map(item => ({
            ...item,
            vector: [],
            score: score(item)
        }));
    const toCandidates = (run: Awaited<ReturnType<Retriever['retrieve']>>, candidateK: number): SearchResult[] =>
        toResults(run.fusedCandidates.slice(0, candidateK), candidate => candidate.fusionScore);
    const toMatches = (run: Awaited<ReturnType<Retriever['retrieve']>>): SearchResult[] =>
        toResults(run.evidences, evidence => evidence.evidenceRankingScore
            ?? evidence.evidenceRerankScore
            ?? evidence.chunkRankingScore
            ?? evidence.chunkRerankScore
            ?? evidence.fusionScore);
    const toStages = (run: Awaited<ReturnType<Retriever['retrieve']>>): EvalRetrievalStages => ({
        ...(run.sparseCandidates.length
            ? { sparse: toResults(run.sparseCandidates, item => item.sparseScore ?? item.fusionScore) }
            : {}),
        ...(run.denseCandidates.length
            ? { dense: toResults(run.denseCandidates, item => item.denseScore ?? item.fusionScore) }
            : {}),
        fusion: toResults(run.fusedCandidates, item => item.fusionScore),
        ...(run.rerankedCandidates.some(item => item.chunkRerankScore !== undefined)
            ? { chunkRerank: toResults(run.rerankedCandidates, item => item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore) }
            : {}),
        ...(run.sourceLocalCandidates.length
            ? { sourceLocal: toResults(run.sourceLocalCandidates, item => item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore) }
            : {}),
        ...(run.sourceLocalCandidates.length
            ? { anchorSelection: toResults(run.anchorCandidates, item => item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore) }
            : {}),
        evidenceAssembly: toResults(run.assembledEvidences, item => item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore),
        ...(run.rerankedEvidences.some(item => item.evidenceRerankScore !== undefined)
            ? { evidenceRerank: toResults(run.rerankedEvidences, item => item.evidenceRankingScore ?? item.evidenceRerankScore ?? item.chunkRankingScore ?? item.chunkRerankScore ?? item.fusionScore) }
            : {}),
        final: toMatches(run)
    });
    return {
        name: retriever.profile.id,
        candidateSearch: async (item, candidateK) => {
            const run = await retriever.retrieve(item.question, { topK: candidateK });
            return toCandidates(run, candidateK);
        },
        async search(item, topK) {
            const run = await retriever.retrieve(item.question, { topK });
            return toMatches(run);
        },
        async evaluate(item, candidateK, topK) {
            const run = await retriever.retrieve(item.question, { topK });
            return {
                candidates: toCandidates(run, candidateK),
                matches: toMatches(run),
                stages: toStages(run)
            };
        }
    };
}

/**
 * 创建全文检索评测器。每个知识源独立检索后补齐 source 前缀，
 * 使其输出与向量检索器使用同一套 SearchResult 和评分逻辑。
 */
export function createGrepEvalRetriever(
    sourceRoots: KnowledgeSourceRoot[],
    options: EvalRetrieverOptions
): EvalRetriever {
    return {
        name: 'grep',
        candidateSearch: async (item, candidateK) => {
            const terms = getGrepTerms(item);
            return rankGrepTermMatches((await Promise.all(sourceRoots.flatMap(sourceRoot =>
                terms.map(async term => ({
                    term,
                    matches: await grepNotes(path.resolve(sourceRoot.root), term, { maxResults: candidateK, ignorePatterns: sourceRoot.ignore }),
                    sourcePrefix: sourceRoot.prefix
                }))
            ))).flatMap(({ term, matches, sourcePrefix }) => matches.map(match => ({
                term, match: { ...match, source: sourceWithPrefix(sourcePrefix, match.source) }
            }))), terms);
        },
        rerank: (matches, topK) => options.wikiFirst ? prioritizeWikiMatches(matches, topK) : matches.slice(0, topK),
        async search(item, topK) {
            const terms = getGrepTerms(item);
            const candidateLimit = getCandidateLimit(topK, options);
            const termMatches = (await Promise.all(sourceRoots.flatMap(sourceRoot =>
                terms.map(async term => ({
                    term,
                    matches: await grepNotes(path.resolve(sourceRoot.root), term, {
                        maxResults: candidateLimit,
                        ignorePatterns: sourceRoot.ignore
                    }),
                    sourcePrefix: sourceRoot.prefix
                }))
            ))).flatMap(({ term, matches, sourcePrefix }) => matches.map(match => ({
                term,
                match: {
                    ...match,
                    source: sourceWithPrefix(sourcePrefix, match.source)
                }
            })));
            const results = rankGrepTermMatches(termMatches, terms);
            return options.wikiFirst ? prioritizeWikiMatches(results, topK) : results.slice(0, topK);
        }
    };
}

export async function evaluateRetriever(
    questions: EvalQuestion[],
    retriever: EvalRetriever,
    topK = 5,
    onProgress?: (progress: EvalProgress) => void,
    onDecision?: (decision: EvalRetrievalDecision) => Promise<void> | void
): Promise<EvalSummary> {
    const results: EvalQuestionResult[] = [];

    for (const [index, sourceQuestion] of questions.entries()) {
        const item = normalizeEvalQuestion(sourceQuestion, index);
        onProgress?.({ completed: index + 1, total: questions.length, question: item });
        const candidateK = Math.max(topK * 4, topK);
        const startedAt = new Date();
        const startedAtMs = performance.now();
        const evaluated = retriever.evaluate
            ? await retriever.evaluate(item, candidateK, topK)
            : undefined;
        const candidates = evaluated?.candidates ?? (retriever.candidateSearch
            ? await retriever.candidateSearch(item, candidateK)
            : await retriever.search(item, candidateK));
        const matches = evaluated?.matches
            ?? (retriever.rerank ? retriever.rerank(candidates, topK) : candidates.slice(0, topK));
        const result = scoreQuestion(item, matches, candidates, evaluated?.stages);
        results.push(result);
        await onDecision?.({
            question: item,
            retriever: retriever.name,
            topK,
            candidateLimit: candidateK,
            candidates,
            matches,
            ...(evaluated?.stages ? { stages: evaluated.stages } : {}),
            result,
            startedAt,
            elapsedMs: performance.now() - startedAtMs
        });
    }

    const passedCount = results.filter(result => result.passed).length;
    const strictPassedCount = results.filter(result => result.strictPassed).length;
    return {
        status: 'success',
        retriever: retriever.name,
        passed: passedCount,
        strictPassed: strictPassedCount,
        total: results.length,
        accuracy: results.length ? Number((passedCount / results.length).toFixed(2)) : 0,
        strictAccuracy: results.length ? Number((strictPassedCount / results.length).toFixed(2)) : 0,
        metrics: summarizeRetrievalMetrics(results, topK),
        results
    };
}

function getCandidateLimit(topK: number, options: EvalRetrieverOptions): number {
    return options.wikiFirst ? Math.min(topK * 4, 48) : topK;
}

function getGrepTerms(item: EvalQuestion): string[] {
    const candidates = (item.grepTerms ?? []).map(term => term.trim()).filter(Boolean);
    if (candidates.length > 0) return Array.from(new Set(candidates));
    return [item.question];
}

function rankGrepTermMatches(
    termMatches: Array<{ term: string; match: GrepNotesMatch }>,
    terms: string[]
): SearchResult[] {
    const grouped = new Map<string, { match: GrepNotesMatch; matchedTerms: Set<string> }>();

    for (const { term, match } of termMatches) {
        const key = `${match.source}:${match.line}`;
        const group = grouped.get(key) ?? { match, matchedTerms: new Set<string>() };
        group.matchedTerms.add(term);
        grouped.set(key, group);
    }

    const groups = Array.from(grouped.values());
    return grepMatchesToSearchResults(groups.map(group => group.match), terms.join(' '))
        .map((result, index) => ({
            ...result,
            score: groups[index].matchedTerms.size / terms.length
        }))
        .sort((left, right) => right.score - left.score || left.source.localeCompare(right.source) || left.start - right.start);
}

export function scoreQuestion(
    item: EvalQuestion,
    matches: SearchResult[],
    candidates = matches,
    stages?: EvalRetrievalStages
): EvalQuestionResult {
    // 把 topK 检索结果合并成一个低成本判分文本，用 expectedTerms 检查召回内容是否包含关键事实。
    const combinedText = matches.map(match => `${match.source}\n${match.text}`).join('\n').toLowerCase();

    // expectedSource 评估“是否召回正确文档”；expectedTerms 评估“召回片段是否覆盖关键概念”。
    // 这里使用 60% 关键词命中率作为轻量阈值，避免单个同义词或切分差异导致评测过于脆弱。
    const expectedSources = resolveExpectedSources(item);
    const stageDiagnostics = stages
        ? diagnoseStages(stages, expectedSources, item.expectedTerms ?? [])
        : undefined;
    const sourceHit = expectedSources.length ? matches.some(match => sourceMatches(match.source, expectedSources)) : true;
    const termHits = item.expectedTerms?.filter(term => combinedText.includes(term.toLowerCase())).length ?? 0;
    const termScore = item.expectedTerms?.length ? termHits / item.expectedTerms.length : 1;
    const passed = sourceHit && termScore >= 0.6;
    const sourceText = (expectedSources.length
        ? matches.filter(match => sourceMatches(match.source, expectedSources))
        : matches
    ).map(match => match.text).join('\n').toLowerCase();
    const sourceTermHits = item.expectedTerms?.filter(term => sourceText.includes(term.toLowerCase())).length ?? 0;
    const sourceTermScore = item.expectedTerms?.length ? sourceTermHits / item.expectedTerms.length : 1;
    const strictPassed = sourceHit && sourceTermScore >= 0.6;
    const rank = expectedSources.length ? matches.findIndex(match => sourceMatches(match.source, expectedSources)) + 1 : 1;

    return {
        ...(item.id ? { id: item.id } : {}),
        ...(item.category ? { category: item.category } : {}),
        question: item.question,
        passed,
        strictPassed,
        sourceHit,
        ...(expectedSources.length ? { expectedSources } : {}),
        termScore: Number(termScore.toFixed(2)),
        sourceTermScore: Number(sourceTermScore.toFixed(2)),
        topSources: matches.map(match => ({ source: match.source, score: Number(match.score.toFixed(4)) })),
        candidateSourceHit: expectedSources.length ? candidates.some(match => sourceMatches(match.source, expectedSources)) : true,
        hitAt1: rank === 1,
        reciprocalRank: rank > 0 ? Number((1 / rank).toFixed(4)) : 0,
        ...(stageDiagnostics ? {
            stageRanks: Object.fromEntries(Object.entries(stageDiagnostics).map(([stage, diagnostic]) => [
                stage,
                diagnostic.sourceRank
            ])) as Partial<Record<RetrievalStageName, number | null>>,
            stageDiagnostics
        } : {})
    };
}

function resolveExpectedSources(item: EvalQuestion): string[] {
    const values = item.expectedSources ?? (item.expectedSource ? [item.expectedSource] : []);
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function sourceMatches(source: string, expectedSources: string[]): boolean {
    const normalizedSource = source.toLowerCase();
    return expectedSources.some(expectedSource => normalizedSource.includes(expectedSource.toLowerCase()));
}

function rankExpectedSource(matches: Array<{ source: string }>, expectedSources: string[]): number | undefined {
    const rank = matches.findIndex(match => sourceMatches(match.source, expectedSources));
    return rank < 0 ? undefined : rank + 1;
}

function diagnoseStages(
    stages: EvalRetrievalStages,
    expectedSources: string[],
    expectedTerms: string[]
): NonNullable<EvalQuestionResult['stageDiagnostics']> {
    return Object.fromEntries(Object.entries(stages).map(([stage, matches]) => {
        const sourceRank = expectedSources.length ? rankExpectedSource(matches, expectedSources) ?? null : 1;
        const expectedMatches = expectedSources.length
            ? matches.filter(match => sourceMatches(match.source, expectedSources))
            : matches;
        const coverages = expectedMatches.map(match => termCoverage(match.text, expectedTerms));
        const contentIndex = matches.findIndex(match =>
            (!expectedSources.length || sourceMatches(match.source, expectedSources))
            && termCoverage(match.text, expectedTerms) >= 0.6
        );
        return [stage, {
            sourceRank,
            contentRank: contentIndex < 0 ? null : contentIndex + 1,
            bestTermCoverage: Number((coverages.length ? Math.max(...coverages) : 0).toFixed(2))
        }];
    })) as NonNullable<EvalQuestionResult['stageDiagnostics']>;
}

function termCoverage(text: string, expectedTerms: string[]): number {
    if (!expectedTerms.length) return 1;
    const normalized = text.toLowerCase();
    return expectedTerms.filter(term => normalized.includes(term.toLowerCase())).length / expectedTerms.length;
}

export type RetrievalMetrics = {
    candidateRecallAtK: number;
    hitAt1: number;
    recallAtK: number;
    mrr: number;
};

export function summarizeRetrievalMetrics(results: EvalQuestionResult[], _topK: number): RetrievalMetrics {
    if (results.length === 0) return { candidateRecallAtK: 0, hitAt1: 0, recallAtK: 0, mrr: 0 };
    const ratio = (predicate: (result: EvalQuestionResult) => boolean) =>
        Number((results.filter(predicate).length / results.length).toFixed(4));
    return {
        candidateRecallAtK: ratio(result => result.candidateSourceHit === true),
        hitAt1: ratio(result => result.hitAt1 === true),
        recallAtK: ratio(result => result.sourceHit),
        mrr: Number((results.reduce((sum, result) => sum + (result.reciprocalRank ?? 0), 0) / results.length).toFixed(4))
    };
}
