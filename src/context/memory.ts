import OpenAI from 'openai';
import { getActiveSpan } from '../trace/telemetry.js';
import { IMemory } from '../types.js';
import { estimateMessagesSize } from '../utils/tokenBudget.js';
import { LongTermMemoryItem, LongTermMemoryKind, MemoryStore, SessionListItem, SessionOverview } from './memoryStore.js';
import { ContextSnapshot, TrajectoryStepRecord, buildContextSnapshot, renderContextSnapshots } from './contextSnapshot.js';
import { EvidenceEntry } from './evidenceSufficiency.js';
import {
    CreateMemoryProposalInput,
    MemoryProposal,
    MemoryProposalStatus,
    createMemoryProposal,
    transitionMemoryProposal
} from './memoryProposal.js';
import { submitVerifiedProposal, verifyMemoryProposal } from './memoryVerifier.js';

type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

class ShortTermMemory {
    private messages: MemoryMessage[] = [];

    append(message: MemoryMessage): void {
        this.messages.push(message);
    }

    getMessages(): MemoryMessage[] {
        return [...this.messages];
    }

    replace(messages: MemoryMessage[]): void {
        this.messages = [...messages];
    }

    clear(): void {
        this.messages = [];
    }
}

class MidTermMemory {
    private snapshots: ContextSnapshot[] = [];
    private evidence: EvidenceEntry[] = [];
    private trajectorySteps: TrajectoryStepRecord[] = [];
    private memoryProposalIds: string[] = [];

    mergeMessages(messages: MemoryMessage[]): void {
        this.snapshots.push(buildContextSnapshot({
            messages,
            evidence: this.evidence,
            trajectorySteps: this.trajectorySteps,
            memoryProposalIds: this.memoryProposalIds
        }));
        this.snapshots = this.snapshots.slice(-4);
        this.evidence = [];
        this.trajectorySteps = [];
        this.memoryProposalIds = [];
    }

    recordStep(record: TrajectoryStepRecord, evidence: readonly EvidenceEntry[]): void {
        this.trajectorySteps.push(record);
        this.evidence.push(...evidence);
    }

    recordMemoryProposal(proposalId: string): void {
        this.memoryProposalIds.push(proposalId);
    }

    toMessage(): MemoryMessage | undefined {
        if (this.snapshots.length === 0) return undefined;
        return {
            role: 'system',
            content: `以下是较早上下文的自动压缩摘要（确定性结构化快照），用于保持任务连续性；被截断的正文必须重新读取来源后再引用：\n${renderContextSnapshots(this.snapshots)}`
        };
    }

    clear(): void {
        this.snapshots = [];
        this.evidence = [];
        this.trajectorySteps = [];
        this.memoryProposalIds = [];
    }
}

class LongTermMemory {
    private items: LongTermMemoryItem[] = [];

    toMessage(): MemoryMessage | undefined {
        if (this.items.length === 0) return undefined;
        return {
            role: 'system',
            content: `以下是经用户明确确认的长期记忆，用于保持跨任务连续性：\n${this.items.map((item, index) => `${index + 1}. [${item.kind}] ${item.content}`).join('\n')}`
        };
    }

    replace(items: LongTermMemoryItem[]): void {
        this.items = [...items];
    }

    add(item: LongTermMemoryItem): void {
        const existingIndex = this.items.findIndex(existing => existing.id === item.id);
        if (existingIndex >= 0) {
            this.items[existingIndex] = item;
        } else {
            this.items.unshift(item);
        }
    }

    getItems(): LongTermMemoryItem[] {
        return [...this.items];
    }

    remove(memoryId: string): boolean {
        const existingIndex = this.items.findIndex(item => item.id === memoryId);
        if (existingIndex < 0) return false;
        this.items.splice(existingIndex, 1);
        return true;
    }

    clear(): void {
        this.items = [];
    }
}

type MemoryManagerOptions = {
    maxHistoryMessages?: number;
    keepRecentMessages?: number;
    sessionId?: string;
    memoryDirectory?: string;
    sessionRetentionDays?: number;
    journalRetentionDays?: number;
};

export class MemoryManager implements IMemory {
    private readonly systemMessage?: MemoryMessage;
    private readonly shortTerm = new ShortTermMemory();
    private readonly midTerm = new MidTermMemory();
    private readonly longTerm = new LongTermMemory();
    private readonly maxHistoryMessages: number;
    private readonly keepRecentMessages: number;
    private readonly maxHistoryChars: number;
    private readonly store?: MemoryStore;
    readonly sessionId?: string;
    readonly resumedSession: boolean;

    constructor(systemPrompt: string, options: MemoryManagerOptions = {}) {
        this.maxHistoryMessages = options.maxHistoryMessages ?? Number(process.env.MEMORY_MAX_MESSAGES ?? 40);
        this.keepRecentMessages = options.keepRecentMessages ?? Number(process.env.MEMORY_KEEP_RECENT_MESSAGES ?? 18);
        this.maxHistoryChars = Number(process.env.MEMORY_MAX_CHARS ?? 60000);
        if (systemPrompt.trim()) {
            this.systemMessage = { role: 'system', content: systemPrompt.trim() };
        }
        const shouldPersist = options.memoryDirectory !== undefined || options.sessionId !== undefined;
        if (shouldPersist) {
            this.store = new MemoryStore(options.memoryDirectory);
            this.store.prune({
                sessionRetentionDays: options.sessionRetentionDays ?? readRetentionDays('MEMORY_SESSION_RETENTION_DAYS', 30),
                journalRetentionDays: options.journalRetentionDays ?? readRetentionDays('MEMORY_JOURNAL_RETENTION_DAYS', 90)
            });
            this.sessionId = options.sessionId ?? this.store.createSessionId();
            this.resumedSession = this.store.hasSession(this.sessionId);
            this.store.ensureSession(this.sessionId);
            this.shortTerm.replace(this.store.loadSessionMessages(this.sessionId));
            this.longTerm.replace(this.store.loadLongTermMemories());
            this.compactIfNeeded();
        } else {
            this.resumedSession = false;
        }
    }

    getMessages(): MemoryMessage[] {
        return [
            ...(this.systemMessage ? [this.systemMessage] : []),
            ...[this.midTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...[this.longTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...this.shortTerm.getMessages()
        ];
    }

    append(message: MemoryMessage): void {
        const toolCalls = 'tool_calls' in message ? message.tool_calls : undefined;
        if (!message.content && (!toolCalls || toolCalls.length === 0)) return;
        this.shortTerm.append(message);
        if (this.store && this.sessionId) {
            this.store.appendSessionMessage(this.sessionId, message);
        }
        this.compactIfNeeded();
    }

    clear(): void {
        this.shortTerm.clear();
        this.midTerm.clear();
        if (this.store && this.sessionId) {
            this.store.clearSessionMessages(this.sessionId);
        } else {
            this.longTerm.clear();
        }
        console.log('🧹 [MemoryManager] 会话历史已被清空；长期记忆保持不变。');
    }

    getRoundCount(): number {
        return this.shortTerm.getMessages().filter(msg => msg.role === 'user').length;
    }

    recordTrajectoryStep(record: TrajectoryStepRecord, evidence: readonly EvidenceEntry[] = []): void {
        this.midTerm.recordStep(record, evidence);
    }

    recordMemoryProposal(proposalId: string): void {
        this.midTerm.recordMemoryProposal(proposalId);
    }

    remember(content: string, kind: LongTermMemoryKind = 'fact'): LongTermMemoryItem {
        if (!this.store) {
            throw new Error('persistent memory store is not configured');
        }
        const item = this.store.remember(content, kind);
        this.longTerm.add(item);
        return item;
    }

    proposeMemory(input: CreateMemoryProposalInput): MemoryProposal {
        if (!this.store) throw new Error('persistent memory store is not configured');
        const proposed = createMemoryProposal({ ...input, sessionId: input.sessionId ?? this.sessionId });
        this.store.saveMemoryProposal(proposed);
        const verified = verifyMemoryProposal(proposed, this.longTerm.getItems());
        this.store.saveMemoryProposal(verified);
        const result = verified.status === 'verified'
            ? submitVerifiedProposal(verified)
            : verified;
        this.store.saveMemoryProposal(result);
        this.recordMemoryProposal(result.id);
        return result;
    }

    listMemoryProposals(status?: MemoryProposalStatus): MemoryProposal[] {
        return this.store?.listMemoryProposals(status) ?? [];
    }

    approveMemoryProposal(proposalId: string): MemoryProposal {
        if (!this.store) throw new Error('persistent memory store is not configured');
        const proposal = this.store.getMemoryProposal(proposalId);
        if (!proposal) throw new Error(`memory proposal not found: ${proposalId}`);
        const approved = transitionMemoryProposal(proposal, 'approved');
        this.store.saveMemoryProposal(approved);
        const committed = this.store.commitApprovedProposal(proposalId);
        this.longTerm.add(committed.memory);
        return committed.proposal;
    }

    rejectMemoryProposal(proposalId: string): MemoryProposal {
        if (!this.store) throw new Error('persistent memory store is not configured');
        const proposal = this.store.getMemoryProposal(proposalId);
        if (!proposal) throw new Error(`memory proposal not found: ${proposalId}`);
        const rejected = transitionMemoryProposal(proposal, 'rejected_user');
        return this.store.saveMemoryProposal(rejected);
    }

    getLongTermMemories(): LongTermMemoryItem[] {
        return this.longTerm.getItems();
    }

    forget(memoryId: string): boolean {
        if (!this.store) {
            throw new Error('persistent memory store is not configured');
        }
        if (!this.store.forget(memoryId)) return false;
        return this.longTerm.remove(memoryId);
    }

    listSessions(limit = 20, previewChars = 120): SessionListItem[] {
        return this.store?.listSessions(limit, previewChars) ?? [];
    }

    getSessionOverview(sessionId: string, previewChars = 1000): SessionOverview | undefined {
        return this.store?.getSessionOverview(sessionId, previewChars);
    }

    close(): void {
        this.store?.close();
    }

    private compactIfNeeded(): void {
        const beforeCount = this.getMessages().length;
        const shortTermMessages = this.shortTerm.getMessages();
        const rawMessageCount = shortTermMessages.length + (this.systemMessage ? 1 : 0);
        const historyChars = estimateMessagesSize(this.getMessages()).chars;
        const countExceeded = rawMessageCount > this.maxHistoryMessages;
        const charsExceeded = historyChars > this.maxHistoryChars;
        if (!countExceeded && !charsExceeded) return;

        let splitIndex = Math.max(0, shortTermMessages.length - this.keepRecentMessages);
        while (splitIndex > 0 && shortTermMessages[splitIndex]?.role === 'tool') splitIndex--;
        const recent = shortTermMessages.slice(splitIndex);
        const old = shortTermMessages.slice(0, splitIndex);
        if (old.length === 0) return;

        this.midTerm.mergeMessages(old);
        this.shortTerm.replace(recent);
        const afterMessages = this.getMessages();
        void getActiveSpan()?.addEvent('memory.compaction', {
            'wiki_agent.memory.before_count': beforeCount,
            'wiki_agent.memory.after_count': afterMessages.length,
            'wiki_agent.memory.summarized_count': old.length,
            'wiki_agent.memory.reason': countExceeded ? 'max_messages' : 'max_chars'
        });
        console.log('🧹 [MemoryManager] 历史上下文已自动压缩，保留近期关键消息。');
    }
}

function readRetentionDays(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
