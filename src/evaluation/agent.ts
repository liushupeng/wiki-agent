export type AgentEvalQuestion = {
    id: string;
    category?: string;
    queryType?: string;
    primaryStage?: 'candidate-retrieval' | 'rerank' | 'evidence' | 'agent';
    difficulty?: 'easy' | 'medium' | 'hard';
    question: string;
    expectedSource?: string;
    expectedTerms?: string[];
};

export function selectAgentEvalQuestions(
    questions: AgentEvalQuestion[],
    options: { randomCount?: number; seed?: string; questionIds?: string[] }
): AgentEvalQuestion[] {
    const ids = new Set(questions.map(question => question.id));
    if (options.questionIds?.length) {
        const unknown = options.questionIds.filter(id => !ids.has(id));
        if (unknown.length) throw new Error(`unknown --question-ids: ${unknown.join(', ')}`);
    }
    if (options.questionIds?.length && options.randomCount !== undefined) {
        throw new Error('--random-count and --question-ids cannot be used together');
    }
    const selected = options.questionIds?.length ? questions.filter(question => options.questionIds!.includes(question.id)) : questions.slice();
    if (options.randomCount === undefined) return selected;
    if (!Number.isInteger(options.randomCount) || options.randomCount <= 0 || options.randomCount > selected.length) {
        throw new Error(`--random-count must be a positive integer no larger than ${selected.length}`);
    }
    return seededShuffle(selected, options.seed ?? 'wiki-agent-eval').slice(0, options.randomCount);
}

export type AgentAggregate = {
    total: number; passRate: number; failureRate: number; averageLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; averageSteps: number;
};

export function summarizeAgentResults(results: AgentEvalResult[]): AgentAggregate {
    const latencies = results.map(result => result.trace.totalLatencyMs ?? 0).sort((a, b) => a - b);
    const percentile = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)]! : 0;
    const passed = results.filter(result => result.passed).length;
    return {
        total: results.length, passRate: results.length ? round(passed / results.length) : 0, failureRate: results.length ? round(1 - passed / results.length) : 0,
        averageLatencyMs: results.length ? round(latencies.reduce((sum, value) => sum + value, 0) / results.length) : 0,
        p50LatencyMs: percentile(0.5), p95LatencyMs: percentile(0.95),
        averageSteps: results.length ? round(results.reduce((sum, result) => sum + result.trace.stepCount, 0) / results.length) : 0
    };
}

export function summarizeAgentResultsByCategory(results: AgentEvalResult[]): Record<string, AgentAggregate> {
    const grouped = new Map<string, AgentEvalResult[]>();
    for (const result of results) {
        const category = result.category ?? 'uncategorized';
        const values = grouped.get(category) ?? [];
        values.push(result);
        grouped.set(category, values);
    }
    return Object.fromEntries(Array.from(grouped.entries()).map(([category, values]) => [category, summarizeAgentResults(values)]));
}

function seededShuffle<T>(items: T[], seed: string): T[] {
    let state = Array.from(seed).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 2166136261);
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    return shuffled;
}

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

export type ToolFailure = {
    name: string;
    status: string;
    error?: string;
};

export type AgentTraceMetrics = {
    stepCount: number;
    totalLatencyMs?: number;
    totalToolCallCount: number;
    ragToolCallCount: number;
    ragToolUsageRate: number;
    toolFailures: ToolFailure[];
    terminationReason?: string;
    evidenceSources: string[];
};

export type AgentEvalResult = {
    id: string;
    category?: string;
    question: string;
    answer: string;
    expectedTerms: string[];
    matchedTerms: string[];
    termCoverage: number;
    expectedSource?: string;
    sourceHit: boolean;
    sourceEvidence: string[];
    passed: boolean;
    trace: AgentTraceMetrics;
};

const RAG_TOOL_NAMES = new Set(['search_notes', 'grep_notes', 'read_note', 'related_notes']);

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

export function collectAgentTraceMetrics(records: JsonlV2Record[]): AgentTraceMetrics {
    const starts = new Map<string, JsonlV2Record>();
    const evidenceSources = new Set<string>();
    const toolFailures: ToolFailure[] = [];
    let stepCount = 0;
    let totalToolCallCount = 0;
    let ragToolCallCount = 0;
    let runStart: JsonlV2Record | undefined;
    let runEnd: JsonlV2Record | undefined;

    for (const record of records) {
        if (record.type === 'span_start') {
            starts.set(record.spanId, record);
            if (record.name === 'wiki_agent.run') runStart = record;
            if (record.name?.startsWith('wiki_agent.step.')) stepCount += 1;
            if (record.name === 'rag.read_note') addSource(evidenceSources, stringAttribute(record, 'wiki_agent.rag.note_path'));
            if (record.name === 'tool.execute') {
                totalToolCallCount += 1;
                if (isRagTool(stringAttribute(record, 'tool.name'))) ragToolCallCount += 1;
            }
            continue;
        }

        if (record.type !== 'span_end') continue;
        const start = starts.get(record.spanId);
        if (start?.name === 'wiki_agent.run') runEnd = record;
        if (start?.name === 'rag.read_note') addSource(evidenceSources, stringAttribute(start, 'wiki_agent.rag.note_path'));
        if (start?.name === 'rag.search') addSources(evidenceSources, stringAttribute(record, 'wiki_agent.rag.sources'));
        if (start?.name === 'tool.execute' && record.status !== 'ok') {
            toolFailures.push({
                name: stringAttribute(start, 'tool.name') || 'unknown',
                status: stringAttribute(record, 'tool.status') || record.status || 'unknown',
                ...(stringAttribute(record, 'error.message') ? { error: stringAttribute(record, 'error.message') } : {})
            });
        }
    }

    const startMillis = timestampOf(runStart?.startedAt ?? runStart?.at);
    const endMillis = timestampOf(runEnd?.endedAt ?? runEnd?.at);
    return {
        stepCount,
        ...(startMillis !== undefined && endMillis !== undefined ? { totalLatencyMs: Math.max(0, endMillis - startMillis) } : {}),
        totalToolCallCount,
        ragToolCallCount,
        ragToolUsageRate: totalToolCallCount === 0 ? 0 : round(ragToolCallCount / totalToolCallCount),
        toolFailures,
        ...(stringAttribute(runEnd, 'wiki_agent.termination_reason') ? { terminationReason: stringAttribute(runEnd, 'wiki_agent.termination_reason') } : {}),
        evidenceSources: Array.from(evidenceSources)
    };
}

export function scoreAgentAnswer(question: AgentEvalQuestion, answer: string, trace: AgentTraceMetrics): AgentEvalResult {
    const expectedTerms = question.expectedTerms ?? [];
    const normalizedAnswer = answer.toLowerCase();
    const matchedTerms = expectedTerms.filter(term => normalizedAnswer.includes(term.toLowerCase()));
    const termCoverage = expectedTerms.length === 0 ? 1 : round(matchedTerms.length / expectedTerms.length);
    const sourceEvidence = question.expectedSource
        ? trace.evidenceSources.filter(source => source.toLowerCase().includes(question.expectedSource!.toLowerCase()))
        : trace.evidenceSources;
    const sourceHit = question.expectedSource ? sourceEvidence.length > 0 : true;

    return {
        id: question.id,
        ...(question.category ? { category: question.category } : {}),
        question: question.question,
        answer,
        expectedTerms,
        matchedTerms,
        termCoverage,
        ...(question.expectedSource ? { expectedSource: question.expectedSource } : {}),
        sourceHit,
        sourceEvidence,
        passed: sourceHit && termCoverage >= 0.6,
        trace
    };
}

function isJsonlV2Record(value: unknown): value is JsonlV2Record {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.schemaVersion === 2
        && (record.type === 'span_start' || record.type === 'span_end' || record.type === 'span_event')
        && typeof record.traceId === 'string'
        && typeof record.spanId === 'string'
        && typeof record.at === 'string';
}

function isRagTool(name: string): boolean {
    return RAG_TOOL_NAMES.has(name) || name.endsWith('_search_notes') || name.endsWith('_grep_notes') || name.endsWith('_read_note') || name.endsWith('_related_notes');
}

function addSources(target: Set<string>, serialized: string): void {
    if (!serialized) return;
    try {
        const values = JSON.parse(serialized);
        if (Array.isArray(values)) values.forEach(value => addSource(target, typeof value === 'string' ? value : ''));
        return;
    } catch {
        serialized.split(/\n|;/).forEach(value => addSource(target, value));
    }
}

function addSource(target: Set<string>, value: string): void {
    const source = value.replace(/\\/g, '/').trim();
    if (source) target.add(source);
}

function stringAttribute(record: JsonlV2Record | undefined, name: string): string {
    const value = record?.attributes?.[name];
    return typeof value === 'string' ? value : '';
}

function timestampOf(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : timestamp;
}

function round(value: number): number {
    return Number(value.toFixed(4));
}
