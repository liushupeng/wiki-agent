import { SearchResult } from './types.js';
import { VectorStore } from './vectorStore.js';

export type EvalQuestion = {
    question: string;
    grepQuery?: string;
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

export async function evaluateRag(
    questions: EvalQuestion[],
    vectorStore: Pick<VectorStore, 'search'>,
    topK = 5
): Promise<EvalSummary> {
    return evaluateRetriever(questions, {
        name: 'vector',
        search: item => vectorStore.search(item.question, topK)
    }, topK);
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
