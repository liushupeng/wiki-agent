import path from 'node:path';
import { GrepNotesMatch, grepMatchesToSearchResults, grepNotes } from './grep.js';
import { prioritizeWikiMatches } from './ranking.js';
import { KnowledgeSourceRoot, sourceWithPrefix } from './sourceRoots.js';
import { SearchResult } from './types.js';
import { IndexRuntime } from './indexRuntime.js';

export type EvalQuestion = {
    question: string;
    grepTerms?: string[];
    expectedSource?: string;
    expectedTerms?: string[];
};

export type EvalQuestionResult = {
    question: string;
    passed: boolean;
    sourceHit: boolean;
    termScore: number;
    topSources: Array<{ source: string; score: number }>;
};

export type EvalSummary = {
    status: 'success';
    retriever: string;
    passed: number;
    total: number;
    accuracy: number;
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
};

export type EvalRetrieverOptions = {
    wikiFirst: boolean;
};

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

    for (const item of questions) {
        const matches = await retriever.search(item, topK);
        results.push(scoreQuestion(item, matches));
    }

    const passedCount = results.filter(result => result.passed).length;
    return {
        status: 'success',
        retriever: retriever.name,
        passed: passedCount,
        total: results.length,
        accuracy: results.length ? Number((passedCount / results.length).toFixed(2)) : 0,
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

export function scoreQuestion(item: EvalQuestion, matches: SearchResult[]): EvalQuestionResult {
    // 把 topK 检索结果合并成一个低成本判分文本，用 expectedTerms 检查召回内容是否包含关键事实。
    const combinedText = matches.map(match => `${match.source}\n${match.text}`).join('\n').toLowerCase();

    // expectedSource 评估“是否召回正确文档”；expectedTerms 评估“召回片段是否覆盖关键概念”。
    // 这里使用 60% 关键词命中率作为轻量阈值，避免单个同义词或切分差异导致评测过于脆弱。
    const sourceHit = item.expectedSource ? matches.some(match => match.source.includes(item.expectedSource!)) : true;
    const termHits = item.expectedTerms?.filter(term => combinedText.includes(term.toLowerCase())).length ?? 0;
    const termScore = item.expectedTerms?.length ? termHits / item.expectedTerms.length : 1;
    const passed = sourceHit && termScore >= 0.6;

    return {
        question: item.question,
        passed,
        sourceHit,
        termScore: Number(termScore.toFixed(2)),
        topSources: matches.map(match => ({ source: match.source, score: Number(match.score.toFixed(4)) }))
    };
}
