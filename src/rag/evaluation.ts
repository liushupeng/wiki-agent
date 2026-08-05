import path from 'node:path';
import { GrepNotesMatch, grepMatchesToSearchResults, grepNotes } from './grep.js';
import { prioritizeWikiMatches } from './ranking.js';
import { KnowledgeSourceRoot, sourceWithPrefix } from './sourceRoots.js';
import { SearchResult } from './types.js';
import { IndexRuntime } from './indexRuntime.js';

export type EvalQuestion = {
    id?: string;
    category?: string;
    queryType?: string;
    primaryStage?: 'candidate-retrieval' | 'rerank' | 'evidence' | 'agent';
    difficulty?: 'easy' | 'medium' | 'hard';
    question: string;
    grepTerms?: string[];
    expectedSource?: string;
    expectedTerms?: string[];
};

export type EvalQuestionResult = {
    id?: string;
    category?: string;
    question: string;
    passed: boolean;
    sourceHit: boolean;
    termScore: number;
    topSources: Array<{ source: string; score: number }>;
    candidateSourceHit?: boolean;
    hitAt1?: boolean;
    reciprocalRank?: number;
};

export type EvalSummary = {
    status: 'success';
    retriever: string;
    passed: number;
    total: number;
    accuracy: number;
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
    topK = 5
): Promise<EvalSummary> {
    const results: EvalQuestionResult[] = [];

    for (const [index, sourceQuestion] of questions.entries()) {
        const item = normalizeEvalQuestion(sourceQuestion, index);
        const candidateK = Math.max(topK * 4, topK);
        const candidates = retriever.candidateSearch
            ? await retriever.candidateSearch(item, candidateK)
            : await retriever.search(item, candidateK);
        const matches = retriever.rerank ? retriever.rerank(candidates, topK) : candidates.slice(0, topK);
        results.push(scoreQuestion(item, matches, candidates));
    }

    const passedCount = results.filter(result => result.passed).length;
    return {
        status: 'success',
        retriever: retriever.name,
        passed: passedCount,
        total: results.length,
        accuracy: results.length ? Number((passedCount / results.length).toFixed(2)) : 0,
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

export function scoreQuestion(item: EvalQuestion, matches: SearchResult[], candidates = matches): EvalQuestionResult {
    // 把 topK 检索结果合并成一个低成本判分文本，用 expectedTerms 检查召回内容是否包含关键事实。
    const combinedText = matches.map(match => `${match.source}\n${match.text}`).join('\n').toLowerCase();

    // expectedSource 评估“是否召回正确文档”；expectedTerms 评估“召回片段是否覆盖关键概念”。
    // 这里使用 60% 关键词命中率作为轻量阈值，避免单个同义词或切分差异导致评测过于脆弱。
    const sourceHit = item.expectedSource ? matches.some(match => match.source.includes(item.expectedSource!)) : true;
    const termHits = item.expectedTerms?.filter(term => combinedText.includes(term.toLowerCase())).length ?? 0;
    const termScore = item.expectedTerms?.length ? termHits / item.expectedTerms.length : 1;
    const passed = sourceHit && termScore >= 0.6;
    const expectedSource = item.expectedSource?.toLowerCase();
    const rank = expectedSource ? matches.findIndex(match => match.source.toLowerCase().includes(expectedSource)) + 1 : 1;

    return {
        ...(item.id ? { id: item.id } : {}),
        ...(item.category ? { category: item.category } : {}),
        question: item.question,
        passed,
        sourceHit,
        termScore: Number(termScore.toFixed(2)),
        topSources: matches.map(match => ({ source: match.source, score: Number(match.score.toFixed(4)) })),
        candidateSourceHit: expectedSource ? candidates.some(match => match.source.toLowerCase().includes(expectedSource)) : true,
        hitAt1: rank === 1,
        reciprocalRank: rank > 0 ? Number((1 / rank).toFixed(4)) : 0
    };
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
