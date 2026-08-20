import type { EvidenceAssessment } from './evidenceSufficiency.js';

export type RuntimeEvidenceSnapshot = {
    inventoryState: EvidenceAssessment['state'];
    evidenceCount: number;
    distinctSources: number;
    citedCount: number;
    truncatedCount: number;
    conflictedCount: number;
    lowAuthorityCount: number;
    ragCallsUsed: number;
    ragCallsRemaining?: number;
    ragBudgetExhausted: boolean;
};

export type FinalAnswerPolicyResult = {
    content: string;
    action: 'allow' | 'forced-abstention';
    reason: string;
    snapshot: RuntimeEvidenceSnapshot;
};

/**
 * 运行时证据策略只使用本次运行已观察到的信息，不读取评测金标或预期来源。
 *
 * 当前职责：
 * - 对 RAG 工具调用实施通用预算；
 * - 将证据库存、截断和剩余预算反馈给下一轮模型决策；
 * - 明确提醒模型“有检索命中”不等于“问题已被回答”。
 */
export class RuntimeEvidencePolicy {
    private ragCallsUsed = 0;

    constructor(private readonly maxRagCalls?: number) {
        if (maxRagCalls !== undefined && (!Number.isInteger(maxRagCalls) || maxRagCalls <= 0)) {
            throw new Error('maxRagCalls must be a positive integer');
        }
    }

    reset(): void {
        this.ragCallsUsed = 0;
    }

    recordRagCall(): void {
        this.ragCallsUsed += 1;
    }

    canCallRag(): boolean {
        return this.maxRagCalls === undefined || this.ragCallsUsed < this.maxRagCalls;
    }

    snapshot(assessment: EvidenceAssessment): RuntimeEvidenceSnapshot {
        const remaining = this.maxRagCalls === undefined
            ? undefined
            : Math.max(0, this.maxRagCalls - this.ragCallsUsed);
        return {
            inventoryState: assessment.state,
            evidenceCount: assessment.evidenceCount,
            distinctSources: assessment.distinctSources,
            citedCount: assessment.citedCount,
            truncatedCount: assessment.truncatedCount,
            conflictedCount: assessment.conflictedCount,
            lowAuthorityCount: assessment.lowAuthorityCount,
            ragCallsUsed: this.ragCallsUsed,
            ...(remaining === undefined ? {} : { ragCallsRemaining: remaining }),
            ragBudgetExhausted: remaining === 0
        };
    }

    buildModelFeedback(assessment: EvidenceAssessment): string {
        const snapshot = this.snapshot(assessment);
        return [
            '[RUNTIME_EVIDENCE_POLICY]',
            `evidence_inventory=${snapshot.inventoryState}`,
            `evidence_count=${snapshot.evidenceCount}`,
            `distinct_sources=${snapshot.distinctSources}`,
            `cited_count=${snapshot.citedCount}`,
            `truncated_count=${snapshot.truncatedCount}`,
            `conflicted_count=${snapshot.conflictedCount}`,
            `low_authority_count=${snapshot.lowAuthorityCount}`,
            `rag_calls_used=${snapshot.ragCallsUsed}`,
            `rag_calls_remaining=${snapshot.ragCallsRemaining ?? 'unbounded'}`,
            '注意：inventory 只描述已检索材料数量，不代表材料已经覆盖用户问题。',
            snapshot.ragBudgetExhausted
                ? 'RAG 预算已耗尽：不得继续检索；请回答已证实部分并明确缺口，或拒绝作无证据断言。'
                : '请判断关键问题是否已被证据覆盖；充分则停止检索，不充分时仅做必要的下一次检索。'
        ].join('\n');
    }

    finalizeAnswer(content: string, assessment: EvidenceAssessment): FinalAnswerPolicyResult {
        const snapshot = this.snapshot(assessment);
        if (snapshot.ragCallsUsed === 0 || snapshot.evidenceCount > 0 || containsAbstention(content)) {
            return {
                content,
                action: 'allow',
                reason: snapshot.ragCallsUsed === 0
                    ? 'run did not use RAG'
                    : snapshot.evidenceCount > 0
                        ? 'retrieved evidence is available for model-level coverage judgment'
                        : 'model explicitly acknowledged insufficient evidence',
                snapshot
            };
        }
        return {
            content: '知识库检索没有返回可引用证据，因此我无法确认这个问题的答案。请补充相关笔记、来源或更具体的检索线索。',
            action: 'forced-abstention',
            reason: 'RAG was used but no citable evidence was recorded',
            snapshot
        };
    }
}

function containsAbstention(content: string): boolean {
    return /(没有找到|未找到|证据不足|无法确认|无法从.{0,20}(?:知识库|笔记|来源)|no evidence|cannot confirm|could not find)/i.test(content);
}
