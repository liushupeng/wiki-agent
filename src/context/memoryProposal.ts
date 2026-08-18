import { randomUUID } from 'node:crypto';
import type { LongTermMemoryKind } from './memoryStore.js';

export type MemoryProposalStatus =
    | 'proposed'
    | 'verified'
    | 'rejected_verify'
    | 'pending_approval'
    | 'approved'
    | 'committed'
    | 'rejected_user';

export type MemoryProposalScope = 'session' | 'global';

export type MemoryVerificationReport = {
    passed: boolean;
    reasons: string[];
    checkedAt: string;
};

export type MemoryProposal = {
    id: string;
    status: MemoryProposalStatus;
    kind: LongTermMemoryKind;
    content: string;
    sessionId?: string;
    scope: MemoryProposalScope;
    sourceMessageRefs: string[];
    evidenceRefs: string[];
    userRequest?: string;
    expiresAt?: string;
    conflictTargetIds: string[];
    verification?: MemoryVerificationReport;
    committedMemoryId?: string;
    createdAt: string;
    updatedAt: string;
};

export type CreateMemoryProposalInput = {
    kind?: LongTermMemoryKind;
    content: string;
    sessionId?: string;
    scope?: MemoryProposalScope;
    sourceMessageRefs?: string[];
    evidenceRefs?: string[];
    userRequest?: string;
    expiresAt?: string;
};

const ALLOWED_TRANSITIONS: Record<MemoryProposalStatus, MemoryProposalStatus[]> = {
    proposed: ['verified', 'rejected_verify'],
    verified: ['pending_approval'],
    rejected_verify: [],
    pending_approval: ['approved', 'rejected_user'],
    approved: ['committed'],
    committed: [],
    rejected_user: []
};

export function createMemoryProposal(
    input: CreateMemoryProposalInput,
    now: () => Date = () => new Date()
): MemoryProposal {
    const timestamp = now().toISOString();
    return {
        id: randomUUID(),
        status: 'proposed',
        kind: input.kind ?? 'fact',
        content: input.content.trim().replace(/\s+/g, ' '),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        scope: input.scope ?? 'global',
        sourceMessageRefs: unique(input.sourceMessageRefs ?? []),
        evidenceRefs: unique(input.evidenceRefs ?? []),
        ...(input.userRequest?.trim() ? { userRequest: input.userRequest.trim() } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        conflictTargetIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

export function transitionMemoryProposal(
    proposal: MemoryProposal,
    next: MemoryProposalStatus,
    patch: Partial<MemoryProposal> = {},
    now: () => Date = () => new Date()
): MemoryProposal {
    if (!ALLOWED_TRANSITIONS[proposal.status].includes(next)) {
        throw new Error(`illegal memory proposal transition: ${proposal.status} -> ${next}`);
    }
    return {
        ...proposal,
        ...patch,
        id: proposal.id,
        status: next,
        createdAt: proposal.createdAt,
        updatedAt: now().toISOString()
    };
}

export function isTerminalProposalStatus(status: MemoryProposalStatus): boolean {
    return ALLOWED_TRANSITIONS[status].length === 0;
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
