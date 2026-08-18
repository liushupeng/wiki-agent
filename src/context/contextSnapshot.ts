import OpenAI from 'openai';
import { EvidenceEntry } from './evidenceSufficiency.js';
import {
    DEFAULT_TRAJECTORY_BUDGET,
    TrajectoryBudget,
    clampText,
    keepLatestUnique
} from './trajectoryBudget.js';

type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type SnapshotToolCall = {
    callId: string;
    name: string;
    status: 'pending' | 'success' | 'failed';
    error?: string;
};

export type SnapshotEvidenceReference = Pick<
    EvidenceEntry,
    'source' | 'chunkId' | 'citation' | 'truncated'
>;

export type TrajectoryStepRecord = {
    step: number;
    outcome: 'continue' | 'final' | 'error';
    detail?: string;
};

export type ContextSnapshot = {
    schemaVersion: 1;
    createdAt: string;
    goals: string[];
    confirmedFacts: string[];
    evidenceReferences: SnapshotEvidenceReference[];
    failedAttempts: string[];
    incompleteItems: string[];
    toolCalls: SnapshotToolCall[];
    memoryProposalIds: string[];
    trajectorySteps: TrajectoryStepRecord[];
    conversationNotes: string[];
    compression: {
        sourceMessageCount: number;
        omittedLongBodies: number;
        deterministic: true;
    };
};

export function buildContextSnapshot(input: {
    messages: MemoryMessage[];
    evidence?: readonly EvidenceEntry[];
    memoryProposalIds?: readonly string[];
    trajectorySteps?: readonly TrajectoryStepRecord[];
    now?: () => Date;
    budget?: Partial<TrajectoryBudget>;
}): ContextSnapshot {
    const budget = { ...DEFAULT_TRAJECTORY_BUDGET, ...input.budget };
    const goals: string[] = [];
    const confirmedFacts: string[] = [];
    const failedAttempts: string[] = [];
    const conversationNotes: string[] = [];
    const calls = new Map<string, SnapshotToolCall>();
    let omittedLongBodies = 0;

    for (const message of input.messages) {
        if (message.role === 'user' && typeof message.content === 'string') {
            goals.push(clampText(message.content, budget.maxFieldChars));
            if (message.content.length > budget.maxFieldChars) omittedLongBodies += 1;
        }
        if (message.role === 'assistant') {
            if (typeof message.content === 'string' && message.content.trim()) {
                conversationNotes.push(clampText(message.content, budget.maxFieldChars));
                if (message.content.length > budget.maxFieldChars) omittedLongBodies += 1;
            }
            for (const toolCall of ('tool_calls' in message ? message.tool_calls ?? [] : [])) {
                if (toolCall.type !== 'function') continue;
                calls.set(toolCall.id, { callId: toolCall.id, name: toolCall.function.name, status: 'pending' });
            }
        }
        if (message.role === 'tool') {
            const parsed = parseToolObservation(message.content);
            const call = calls.get(message.tool_call_id);
            if (call) {
                call.status = parsed.status === 'success' ? 'success' : 'failed';
                if (parsed.error) call.error = clampText(parsed.error, budget.maxFieldChars);
            }
            if (parsed.status === 'success') {
                const fact = summarizeToolSuccess(call?.name, parsed.data, budget.maxFieldChars);
                if (fact) confirmedFacts.push(fact);
            } else {
                failedAttempts.push(
                    clampText(`${call?.name ?? 'tool'}：${parsed.error ?? parsed.status ?? '失败'}`, budget.maxFieldChars)
                );
            }
        }
    }

    const toolCalls = [...calls.values()].slice(-budget.maxToolCalls);
    const incompleteItems = toolCalls
        .filter(call => call.status === 'pending')
        .map(call => `工具调用 ${call.name} (${call.callId}) 尚无回执`);
    const evidenceReferences = dedupeEvidence(input.evidence ?? []).slice(-budget.maxEvidenceReferences);
    return {
        schemaVersion: 1,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        goals: keepLatestUnique(goals, budget.maxGoals),
        confirmedFacts: keepLatestUnique(confirmedFacts, budget.maxFacts),
        evidenceReferences,
        failedAttempts: keepLatestUnique(failedAttempts, budget.maxFailedAttempts),
        incompleteItems: keepLatestUnique(incompleteItems, budget.maxIncompleteItems),
        toolCalls,
        memoryProposalIds: keepLatestUnique(input.memoryProposalIds ?? [], budget.maxIncompleteItems),
        trajectorySteps: [...(input.trajectorySteps ?? [])].slice(-budget.maxToolCalls),
        conversationNotes: keepLatestUnique(conversationNotes, budget.maxConversationNotes),
        compression: { sourceMessageCount: input.messages.length, omittedLongBodies, deterministic: true }
    };
}

export function renderContextSnapshots(
    snapshots: readonly ContextSnapshot[],
    budget: Partial<TrajectoryBudget> = {}
): string {
    const resolved = { ...DEFAULT_TRAJECTORY_BUDGET, ...budget };
    const selected = snapshots.slice(-resolved.maxSnapshots);
    return selected.map((snapshot, index) => [
        `快照 ${index + 1}（${snapshot.createdAt}，压缩 ${snapshot.compression.sourceMessageCount} 条消息）：`,
        section('目标', snapshot.goals),
        section('已确认事实', snapshot.confirmedFacts),
        section('证据引用', snapshot.evidenceReferences.map(item =>
            `${item.citation ?? item.source}${item.chunkId ? ` [${item.chunkId}]` : ''}${item.truncated ? '（正文被截断，使用前需重新读取）' : ''}`
        )),
        section('失败尝试', snapshot.failedAttempts),
        section('未完成项', snapshot.incompleteItems),
        section('工具轨迹', snapshot.toolCalls.map(call =>
            `${call.callId} ${call.name}=${call.status}${call.error ? `：${call.error}` : ''}`
        )),
        section('对话要点', snapshot.conversationNotes)
    ].filter(Boolean).join('\n')).join('\n\n');
}

function parseToolObservation(content: unknown): { status?: string; error?: string; data?: unknown } {
    if (typeof content !== 'string') return {};
    try {
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return { status: 'unknown', error: '工具回执无法解析' };
    }
}

function summarizeToolSuccess(name: string | undefined, data: unknown, maxChars: number): string | undefined {
    if (!data || typeof data !== 'object') return name ? `${name} 执行成功` : undefined;
    const value = data as Record<string, unknown>;
    const items = Array.isArray(value.matches)
        ? value.matches.length
        : Array.isArray(value.chunks)
            ? value.chunks.length
            : undefined;
    const source = typeof value.notePath === 'string' ? `，来源 ${value.notePath}` : '';
    return clampText(`${name ?? 'tool'} 执行成功${items !== undefined ? `，返回 ${items} 条` : ''}${source}`, maxChars);
}

function dedupeEvidence(entries: readonly EvidenceEntry[]): SnapshotEvidenceReference[] {
    const values = new Map<string, SnapshotEvidenceReference>();
    for (const entry of entries) {
        const key = `${entry.source}\0${entry.chunkId ?? ''}\0${entry.citation ?? ''}`;
        values.set(key, {
            source: entry.source,
            ...(entry.chunkId ? { chunkId: entry.chunkId } : {}),
            ...(entry.citation ? { citation: entry.citation } : {}),
            truncated: entry.truncated
        });
    }
    return [...values.values()];
}

function section(label: string, values: readonly string[]): string {
    return values.length ? `${label}：\n${values.map(value => `- ${value}`).join('\n')}` : '';
}
