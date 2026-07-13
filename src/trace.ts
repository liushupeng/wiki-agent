import fs from 'fs/promises';
import path from 'path';

export type TerminationReason = 'completed' | 'max_loop_steps' | 'system_error';
export const TRACE_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type TraceLevel = typeof TRACE_LEVELS[number];

type TraceEventBase = {
    level?: TraceLevel;
    at: string;
};

export type TraceEvent =
    | (TraceEventBase & { type: 'run_start'; instruction: string })
    | (TraceEventBase & { type: 'step_start'; step: number })
    | (TraceEventBase & { type: 'assistant_message'; step: number; contentPreview: string; toolCalls: string[] })
    | (TraceEventBase & { type: 'tool_result'; step: number; toolName: string; args: unknown; status: string; durationMs: number; observationPreview: string })
    | (TraceEventBase & { type: 'permission_decision'; toolName: string; action: string; reason: string; riskLevel: string })
    | (TraceEventBase & { type: 'rag_search'; toolName: string; query: string; indexPath: string; topK: number; matchCount: number; topMatches: Array<{ source: string; score: number }> })
    | (TraceEventBase & { type: 'memory_compaction'; beforeCount: number; afterCount: number; summarizedCount: number; retainedCount: number; reason: string })
    | (TraceEventBase & { type: 'run_end'; finalOutputPreview: string; terminationReason: TerminationReason });

export class TraceLogger {
    readonly filePath: string;
    private readonly minimumLevel: TraceLevel;

    constructor(traceDir = 'var/traces', minimumLevel = getTraceLevelFromEnv()) {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.resolve(traceDir, `trace-${safeTimestamp}.jsonl`);
        this.minimumLevel = minimumLevel;
    }

    async write(event: TraceEvent): Promise<void> {
        const normalized = { ...event, level: event.level ?? defaultLevelForEvent(event) };
        if (!shouldWriteTraceLevel(normalized.level, this.minimumLevel)) return;

        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, 'utf-8');
    }
}

export function getTraceLevelFromEnv(env = process.env): TraceLevel {
    const value = (env.TRACE_LEVEL ?? 'info').toLowerCase();
    return isTraceLevel(value) ? value : 'info';
}

export function shouldWriteTraceLevel(level: TraceLevel, minimumLevel: TraceLevel): boolean {
    return TRACE_LEVELS.indexOf(level) >= TRACE_LEVELS.indexOf(minimumLevel);
}

function isTraceLevel(value: string): value is TraceLevel {
    return (TRACE_LEVELS as readonly string[]).includes(value);
}

function defaultLevelForEvent(event: TraceEvent): TraceLevel {
    if (event.type === 'memory_compaction' || event.type === 'permission_decision' || event.type === 'rag_search') {
        return 'debug';
    }

    if (event.type === 'tool_result') {
        return event.status === 'success' ? 'info' : 'warn';
    }

    if (event.type === 'run_end') {
        return event.terminationReason === 'system_error' ? 'error' : 'info';
    }

    return 'info';
}

/**
 * 生成写入 trace 的短文本摘要。
 *
 * Trace 只需要帮助复盘关键内容，不应该把完整回答、工具结果或大段 diff 全量写入。
 * 这里会先把连续空白压成单个空格，再按 maxLength 截断并追加省略号。
 */
export function preview(value: string, maxLength = 600): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
