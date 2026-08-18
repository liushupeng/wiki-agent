import { LongTermMemoryItem } from './memoryStore.js';
import {
    MemoryProposal,
    MemoryVerificationReport,
    transitionMemoryProposal
} from './memoryProposal.js';

const SENSITIVE_PATTERNS = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*\S+/i,
    /\bsk-[a-z0-9_-]{16,}\b/i
];

export function verifyMemoryProposal(
    proposal: MemoryProposal,
    existingMemories: readonly LongTermMemoryItem[],
    now: () => Date = () => new Date()
): MemoryProposal {
    if (proposal.status !== 'proposed') {
        throw new Error(`only proposed memory can be verified; current status is ${proposal.status}`);
    }
    const reasons: string[] = [];
    if (!proposal.content) reasons.push('记忆内容不能为空');
    if (proposal.content.length > 1_000) reasons.push('记忆内容超过 1000 字符');
    if (SENSITIVE_PATTERNS.some(pattern => pattern.test(proposal.content))) reasons.push('记忆疑似包含敏感凭据');
    if (!proposal.userRequest?.trim()) reasons.push('缺少用户明确要求记住该内容的原始请求');
    if (proposal.expiresAt !== undefined && !Number.isFinite(Date.parse(proposal.expiresAt))) {
        reasons.push('有效期不是合法 ISO 日期');
    }
    if (proposal.kind === 'fact' && proposal.sourceMessageRefs.length === 0 && proposal.evidenceRefs.length === 0) {
        reasons.push('事实记忆缺少来源消息或证据引用');
    }

    const normalized = normalize(proposal.content);
    const duplicate = existingMemories.find(item => normalize(item.content) === normalized);
    if (duplicate) reasons.push(`与现有记忆 ${duplicate.id} 重复`);
    const conflicts = existingMemories.filter(item =>
        item.kind === proposal.kind && looksConflicting(item.content, proposal.content)
    );
    if (conflicts.length > 0) reasons.push(`与 ${conflicts.length} 条现有记忆可能冲突`);

    const report: MemoryVerificationReport = {
        passed: reasons.length === 0,
        reasons,
        checkedAt: now().toISOString()
    };
    return transitionMemoryProposal(
        proposal,
        report.passed ? 'verified' : 'rejected_verify',
        { verification: report, conflictTargetIds: conflicts.map(item => item.id) },
        now
    );
}

export function submitVerifiedProposal(
    proposal: MemoryProposal,
    now: () => Date = () => new Date()
): MemoryProposal {
    return transitionMemoryProposal(proposal, 'pending_approval', {}, now);
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function looksConflicting(existing: string, proposed: string): boolean {
    const left = normalize(existing);
    const right = normalize(proposed);
    if (!left || !right || left === right) return false;
    const negation = /(?:不|不要|禁止|never|not|no)/i;
    const leftCore = normalize(existing.replace(negation, ''));
    const rightCore = normalize(proposed.replace(negation, ''));
    return leftCore.length >= 4
        && leftCore === rightCore
        && negation.test(existing) !== negation.test(proposed);
}
