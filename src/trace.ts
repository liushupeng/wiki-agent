import fs from 'fs/promises';
import path from 'path';

export type TerminationReason = 'completed' | 'max_loop_steps' | 'system_error';

export type TraceEvent =
    | { type: 'run_start'; instruction: string; at: string }
    | { type: 'step_start'; step: number; at: string }
    | { type: 'assistant_message'; step: number; contentPreview: string; toolCalls: string[]; at: string }
    | { type: 'tool_result'; step: number; toolName: string; args: unknown; status: string; durationMs: number; observationPreview: string; at: string }
    | { type: 'run_end'; finalOutputPreview: string; terminationReason: TerminationReason; at: string };

export class TraceLogger {
    readonly filePath: string;

    constructor(traceDir = 'var/traces') {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.resolve(traceDir, `trace-${safeTimestamp}.jsonl`);
    }

    async write(event: TraceEvent): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    }
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
