import fs from 'fs/promises';
import path from 'path';

export type TraceEvent =
    | { type: 'run_start'; instruction: string; at: string }
    | { type: 'step_start'; step: number; at: string }
    | { type: 'assistant_message'; step: number; contentPreview: string; toolCalls: string[]; at: string }
    | { type: 'tool_result'; step: number; toolName: string; args: unknown; status: string; durationMs: number; observationPreview: string; at: string }
    | { type: 'run_end'; finalOutputPreview: string; terminationReason?: string; at: string };

export class TraceLogger {
    readonly filePath: string;

    constructor(traceDir = 'traces') {
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.resolve(traceDir, `trace-${safeTimestamp}.jsonl`);
    }

    async write(event: TraceEvent): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    }
}

export function preview(value: string, maxLength = 600): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
