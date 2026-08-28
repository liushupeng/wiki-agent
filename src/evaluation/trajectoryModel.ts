export type JsonlV2Record = {
    type: 'span_start' | 'span_end' | 'span_event';
    schemaVersion: 2;
    traceId: string;
    spanId: string;
    at: string;
    name?: string;
    startedAt?: string;
    endedAt?: string;
    status?: string;
    attributes?: Record<string, unknown>;
};

export type TrajectoryToolCall = {
    spanId: string;
    step?: number;
    name: string;
    callId?: string;
    argumentsPreview?: string;
    argumentsSha256?: string;
    status?: string;
    error?: string;
    permissionAction?: string;
    startedAt: string;
};

export type TrajectoryView = {
    traceId: string;
    stepCount: number;
    terminationReason?: string;
    totalLatencyMs?: number;
    toolCalls: TrajectoryToolCall[];
    evidenceSources: string[];
    readNotePaths: string[];
    evidenceSufficiency?: 'insufficient' | 'partial' | 'sufficient';
    retryLimitReached: boolean;
    finalAnswerAction?: 'allow' | 'forced-abstention';
    finalAnswerReason?: string;
    retrievalProfiles: string[];
    retrievalVariants: string[];
    indexIdentities: string[];
    model?: string;
    buildId?: string;
    runArtifactPath?: string;
};

export function parseJsonlV2(content: string): JsonlV2Record[] {
    return content.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`invalid JSONL at line ${index + 1}`);
        }
        if (!isJsonlV2Record(value)) {
            throw new Error(`unsupported trace schema at line ${index + 1}: expected schemaVersion=2 span event`);
        }
        return value;
    });
}

export function buildTrajectoryView(records: JsonlV2Record[]): TrajectoryView {
    const starts = new Map<string, JsonlV2Record>();
    const tools = new Map<string, TrajectoryToolCall>();
    const evidenceSources = new Set<string>();
    const readNotePaths = new Set<string>();
    let runStart: JsonlV2Record | undefined;
    let runEnd: JsonlV2Record | undefined;
    let stepCount = 0;
    let retryLimitReached = false;
    let evidenceSufficiency: TrajectoryView['evidenceSufficiency'];
    let finalAnswerAction: TrajectoryView['finalAnswerAction'];
    let finalAnswerReason: string | undefined;
    const retrievalProfiles = new Set<string>();
    const retrievalVariants = new Set<string>();
    const indexIdentities = new Set<string>();

    for (const record of records) {
        if (record.type === 'span_start') {
            starts.set(record.spanId, record);
            if (record.name === 'wiki_agent.run') runStart = record;
            if (record.name === 'rag.search') {
                addOptionalString(retrievalProfiles, optionalStringAttribute(record, 'wiki_agent.rag.profile'));
                addOptionalString(retrievalVariants, optionalStringAttribute(record, 'wiki_agent.rag.variant'));
            }
            if (record.name?.startsWith('wiki_agent.step.')) stepCount += 1;
            if (record.name === 'tool.execute') {
                tools.set(record.spanId, {
                    spanId: record.spanId,
                    name: stringAttribute(record, 'tool.name') || 'unknown',
                    callId: optionalStringAttribute(record, 'tool.call_id'),
                    step: optionalNumberAttribute(record, 'wiki_agent.step'),
                    argumentsPreview: optionalStringAttribute(record, 'tool.arguments.preview'),
                    argumentsSha256: optionalStringAttribute(record, 'tool.arguments.sha256'),
                    startedAt: record.startedAt ?? record.at
                });
            }
            if (record.name === 'rag.read_note') {
                const notePath = optionalStringAttribute(record, 'wiki_agent.rag.note_path');
                if (notePath) {
                    readNotePaths.add(notePath);
                    evidenceSources.add(notePath);
                }
            }
            continue;
        }

        if (record.type === 'span_event') {
            if (record.name === 'tool.retry_limit_reached') retryLimitReached = true;
            if (record.name === 'final_answer.policy') {
                finalAnswerAction = parseFinalAnswerAction(optionalStringAttribute(record, 'wiki_agent.final_answer.action'));
                finalAnswerReason = optionalStringAttribute(record, 'wiki_agent.final_answer.reason');
            }
            if (record.name === 'evidence.sufficiency') {
                const state = optionalStringAttribute(record, 'evidence.state');
                if (state === 'insufficient' || state === 'partial' || state === 'sufficient') {
                    evidenceSufficiency = state;
                }
            }
            const tool = tools.get(record.spanId);
            if (tool && record.name === 'tool.permission_decision') {
                tool.permissionAction = optionalStringAttribute(record, 'tool.permission.action');
            }
            const start = starts.get(record.spanId);
            if (start?.name === 'rag.search' && record.name === 'retrieval.result') {
                addRetrievedSources(evidenceSources, optionalStringAttribute(record, 'gen_ai.retrieval.documents'));
            }
            continue;
        }

        const start = starts.get(record.spanId);
        if (start?.name === 'wiki_agent.run') runEnd = record;
        if (start?.name === 'rag.search') {
            addOptionalString(retrievalProfiles, optionalStringAttribute(record, 'wiki_agent.rag.profile'));
            addOptionalString(retrievalVariants, optionalStringAttribute(record, 'wiki_agent.rag.variant'));
            addOptionalString(indexIdentities, optionalStringAttribute(record, 'wiki_agent.rag.index_identity'));
        }
        const tool = tools.get(record.spanId);
        if (tool) {
            tool.status = optionalStringAttribute(record, 'tool.status') ?? record.status;
            tool.error = optionalStringAttribute(record, 'error.message');
        }
        if (start?.name === 'rag.read_note') {
            const notePath = optionalStringAttribute(start, 'wiki_agent.rag.note_path');
            if (notePath) {
                readNotePaths.add(notePath);
                evidenceSources.add(notePath);
            }
        }
    }

    const started = timestampOf(runStart?.startedAt ?? runStart?.at);
    const ended = timestampOf(runEnd?.endedAt ?? runEnd?.at);
    const rootFinalAction = parseFinalAnswerAction(optionalStringAttribute(runEnd, 'wiki_agent.final_answer.action'));
    return {
        traceId: records[0]?.traceId ?? '',
        stepCount,
        terminationReason: optionalStringAttribute(runEnd, 'wiki_agent.termination_reason'),
        ...(started !== undefined && ended !== undefined ? { totalLatencyMs: Math.max(0, ended - started) } : {}),
        toolCalls: [...tools.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
        evidenceSources: [...evidenceSources],
        readNotePaths: [...readNotePaths],
        ...(evidenceSufficiency ? { evidenceSufficiency } : {}),
        retryLimitReached,
        ...(rootFinalAction ?? finalAnswerAction ? { finalAnswerAction: rootFinalAction ?? finalAnswerAction } : {}),
        ...(optionalStringAttribute(runEnd, 'wiki_agent.final_answer.reason') ?? finalAnswerReason
            ? { finalAnswerReason: optionalStringAttribute(runEnd, 'wiki_agent.final_answer.reason') ?? finalAnswerReason }
            : {}),
        retrievalProfiles: [...retrievalProfiles],
        retrievalVariants: [...retrievalVariants],
        indexIdentities: [...indexIdentities],
        ...(optionalStringAttribute(runStart, 'gen_ai.request.model')
            ? { model: optionalStringAttribute(runStart, 'gen_ai.request.model') }
            : {}),
        ...(optionalStringAttribute(runStart, 'wiki_agent.build_id')
            ? { buildId: optionalStringAttribute(runStart, 'wiki_agent.build_id') }
            : {}),
        ...(optionalStringAttribute(runEnd, 'wiki_agent.run_artifact.path')
            ? { runArtifactPath: optionalStringAttribute(runEnd, 'wiki_agent.run_artifact.path') }
            : {})
    };
}

export function toolNameMatches(actual: string, expected: string): boolean {
    return actual === expected || actual.endsWith(`_${expected}`);
}

export function isRagToolName(name: string): boolean {
    return ['search_notes', 'grep_notes', 'read_note', 'related_notes'].some(expected => toolNameMatches(name, expected));
}

function isJsonlV2Record(value: unknown): value is JsonlV2Record {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<JsonlV2Record>;
    return record.schemaVersion === 2
        && ['span_start', 'span_end', 'span_event'].includes(record.type ?? '')
        && typeof record.traceId === 'string'
        && typeof record.spanId === 'string'
        && typeof record.at === 'string';
}

function optionalStringAttribute(record: JsonlV2Record | undefined, key: string): string | undefined {
    const value = record?.attributes?.[key];
    return typeof value === 'string' && value ? value : undefined;
}

function stringAttribute(record: JsonlV2Record, key: string): string {
    return optionalStringAttribute(record, key) ?? '';
}

function optionalNumberAttribute(record: JsonlV2Record, key: string): number | undefined {
    const value = record.attributes?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function addRetrievedSources(target: Set<string>, serialized: string | undefined): void {
    if (!serialized) return;
    try {
        const documents = JSON.parse(serialized);
        if (!Array.isArray(documents)) return;
        for (const document of documents) {
            const source = document && typeof document === 'object'
                ? (document as { source?: unknown }).source
                : undefined;
            if (typeof source === 'string' && source.trim()) target.add(source);
        }
    } catch {
        // A malformed diagnostic attribute should not make the complete trace unreadable.
    }
}

function addOptionalString(target: Set<string>, value: string | undefined): void {
    if (value) target.add(value);
}

function parseFinalAnswerAction(value: string | undefined): TrajectoryView['finalAnswerAction'] {
    return value === 'allow' || value === 'forced-abstention' ? value : undefined;
}

function timestampOf(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
