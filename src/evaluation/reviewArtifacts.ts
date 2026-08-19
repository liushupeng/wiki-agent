import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentEvalResult, AgentEvalRubric } from './agent.js';
import { EvaluationMode } from './experiments.js';

export type ReviewPair = {
    id: string;
    question: string;
    category?: string;
    rawOnly?: AgentEvalResult;
    rawWiki?: AgentEvalResult;
    traceId?: string;
    traceFile?: string;
};

export type ReviewArtifactResult = {
    directory: string;
    reviewJsonlPath: string;
    reviewCsvPath: string;
    reviewHtmlPath: string;
    annotationTemplatePath: string;
    blindMappingPath: string;
    sha256: string;
};

export interface ReviewArtifactWriter {
    write(pairs: ReviewPair[], outputDirectory: string): Promise<ReviewArtifactResult>;
}

export interface ReviewTracePublisher {
    publish(summary: { traceId?: string; artifactPath: string; sha256: string }): Promise<void>;
}

export class NoopReviewTracePublisher implements ReviewTracePublisher {
    async publish(_summary: { traceId?: string; artifactPath: string; sha256: string }): Promise<void> {}
}

export class FileReviewArtifactWriter implements ReviewArtifactWriter {
    constructor(private readonly maxFieldLength = 2_000) {}

    async write(pairs: ReviewPair[], outputDirectory: string): Promise<ReviewArtifactResult> {
        await fs.mkdir(outputDirectory, { recursive: true });
        const mapping = pairs.map(pair => blindPair(pair));
        const reviewRecords = mapping.flatMap(item => item.records);
        const reviewJsonlPath = path.join(outputDirectory, 'review.jsonl');
        const reviewCsvPath = path.join(outputDirectory, 'review.csv');
        const reviewHtmlPath = path.join(outputDirectory, 'review.html');
        const annotationTemplatePath = path.join(outputDirectory, 'annotation-template.csv');
        const blindMappingPath = path.join(outputDirectory, 'blind-mapping.internal.json');
        const jsonl = reviewRecords.map(record => JSON.stringify(limitRecord(record, this.maxFieldLength))).join('\n') + (reviewRecords.length ? '\n' : '');
        await fs.writeFile(reviewJsonlPath, jsonl, 'utf-8');
        await fs.writeFile(reviewCsvPath, toCsv(reviewRecords.map(record => ({
            reviewId: record.reviewId, questionId: record.questionId, variant: record.variant, category: record.category ?? '',
            query: record.query, answer: record.answer, passed: String(record.automaticScore.passed),
            termCoverage: String(record.automaticScore.termCoverage), sourceHit: String(record.automaticScore.sourceHit),
            evidence: record.evidence.join(' | '), traceId: record.traceId ?? '', traceFile: record.traceFile ?? ''
        }))), 'utf-8');
        await fs.writeFile(annotationTemplatePath, toCsv(reviewRecords.map(record => ({
            reviewId: record.reviewId,
            questionId: record.questionId,
            expectedBehavior: record.rubric?.expectedBehavior ?? 'answer',
            correctness: '',
            completeness: '',
            groundedness: '',
            citationAccuracy: record.rubric?.citationRequired ? '' : 'na',
            abstention: record.rubric?.expectedBehavior === 'insufficient-evidence' ? '' : 'na',
            overallPass: '',
            failureTag: '',
            notes: ''
        }))), 'utf-8');
        await fs.writeFile(blindMappingPath, `${JSON.stringify(mapping.map(item => ({ questionId: item.questionId, mapping: item.mapping })), null, 2)}\n`, 'utf-8');
        await fs.writeFile(reviewHtmlPath, renderHtml(reviewRecords), 'utf-8');
        const sha256 = createHash('sha256').update(jsonl).digest('hex');
        return { directory: outputDirectory, reviewJsonlPath, reviewCsvPath, reviewHtmlPath, annotationTemplatePath, blindMappingPath, sha256 };
    }
}

type ReviewRecord = {
    reviewId: string; questionId: string; category?: string; variant: 'A' | 'B'; query: string; answer: string;
    candidateSummary: string[]; rerankSummary: string[]; evidence: string[]; toolTraceSummary: string;
    automaticScore: Pick<AgentEvalResult, 'passed' | 'termCoverage' | 'sourceHit' | 'matchedTerms'>; traceId?: string; traceFile?: string;
    rubric?: AgentEvalRubric;
};

function blindPair(pair: ReviewPair): { questionId: string; mapping: Record<'A' | 'B', EvaluationMode>; records: ReviewRecord[] } {
    const flip = stableBoolean(pair.id);
    const mapping = flip ? { A: 'raw-wiki' as const, B: 'raw-only' as const } : { A: 'raw-only' as const, B: 'raw-wiki' as const };
    const byMode: Record<EvaluationMode, AgentEvalResult | undefined> = { 'raw-only': pair.rawOnly, 'raw-wiki': pair.rawWiki };
    return {
        questionId: pair.id, mapping,
        records: (['A', 'B'] as const).flatMap(variant => {
            const result = byMode[mapping[variant]];
            return result ? [toReviewRecord(pair, result, variant)] : [];
        })
    };
}

function toReviewRecord(pair: ReviewPair, result: AgentEvalResult, variant: 'A' | 'B'): ReviewRecord {
    return {
        reviewId: `${pair.id}-${variant}-${randomUUID().slice(0, 8)}`, questionId: pair.id, category: pair.category, variant,
        query: pair.question, answer: result.answer, candidateSummary: [], rerankSummary: [],
        evidence: result.sourceEvidence,
        toolTraceSummary: [
            `steps=${result.trace.stepCount}`,
            `tools=${result.trace.totalToolCallCount}`,
            `failures=${result.trace.toolFailures.length}`,
            `tokens=${result.trace.tokenUsage?.totalTokens ?? 0}`,
            `estimatedTokens=${(result.trace.tokenUsage?.estimatedInputTokens ?? 0) + (result.trace.tokenUsage?.estimatedOutputTokens ?? 0)}`
        ].join('; '),
        automaticScore: { passed: result.passed, termCoverage: result.termCoverage, sourceHit: result.sourceHit, matchedTerms: result.matchedTerms },
        ...(result.rubric ? { rubric: result.rubric } : {}),
        ...(pair.traceId ? { traceId: pair.traceId } : {}), ...(pair.traceFile ? { traceFile: pair.traceFile } : {})
    };
}

function limitRecord(record: ReviewRecord, max: number): ReviewRecord {
    const shorten = (value: string) => value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
    return { ...record, query: shorten(record.query), answer: shorten(record.answer), evidence: record.evidence.map(shorten), toolTraceSummary: shorten(record.toolTraceSummary) };
}

function stableBoolean(value: string): boolean {
    return createHash('sha256').update(value).digest()[0]! % 2 === 0;
}

function toCsv(rows: Record<string, string>[]): string {
    const headers = Object.keys(rows[0] ?? {});
    const quote = (value: string) => `"${value.replaceAll('"', '""').replace(/\r?\n/g, ' ')}"`;
    return [headers.join(','), ...rows.map(row => headers.map(header => quote(row[header] ?? '')).join(','))].join('\n') + '\n';
}

function renderHtml(records: ReviewRecord[]): string {
    const cards = records.map(record => `<article><h2>${escapeHtml(record.questionId)} · Variant ${record.variant}</h2><p><b>Query:</b> ${escapeHtml(record.query)}</p>${record.rubric ? `<p><b>Expected behavior:</b> ${escapeHtml(record.rubric.expectedBehavior)}</p><p><b>Required facts:</b></p><ul>${record.rubric.requiredFacts.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p><b>Forbidden claims:</b></p><ul>${record.rubric.forbiddenClaims.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p><b>Allowed failure tags:</b> ${escapeHtml(record.rubric.failureTags.join(', '))}</p>` : ''}<p><b>Answer:</b></p><pre>${escapeHtml(record.answer)}</pre><p><b>Evidence:</b> ${escapeHtml(record.evidence.join(', '))}</p><p><b>Auto:</b> pass=${record.automaticScore.passed}, coverage=${record.automaticScore.termCoverage}, source=${record.automaticScore.sourceHit}</p><p><b>Trace:</b> ${escapeHtml(record.toolTraceSummary)}</p></article>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Agent Evaluation Review</title><style>body{font:14px system-ui;max-width:1000px;margin:2rem auto}article{border:1px solid #ddd;padding:1rem;margin:1rem 0}pre{white-space:pre-wrap}</style></head><body><h1>Agent evaluation review</h1><p>Use the rubric below, then record 1/0/na judgements in annotation-template.csv. Variants remain anonymized when an A/B run is used.</p>${cards}</body></html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
