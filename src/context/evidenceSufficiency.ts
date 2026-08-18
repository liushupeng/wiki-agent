import { createHash } from 'node:crypto';
import { ToolResult } from '../types.js';

export type EvidenceSufficiency = 'insufficient' | 'partial' | 'sufficient';

export type EvidenceEntry = {
    id: string;
    toolName: string;
    query?: string;
    source: string;
    chunkId?: string;
    citation?: string;
    truncated: boolean;
    observedAt: string;
};

export type EvidenceAssessment = {
    state: EvidenceSufficiency;
    reasons: string[];
    evidenceCount: number;
    distinctSources: number;
    citedCount: number;
    truncatedCount: number;
};

export type EvidenceRequirements = {
    minItems?: number;
    minDistinctSources?: number;
    requireCitation?: boolean;
    allowTruncated?: boolean;
    expectedSources?: string[];
};

export class EvidenceLedger {
    private readonly entries = new Map<string, EvidenceEntry>();

    constructor(private readonly now: () => Date = () => new Date()) {}

    record(entry: Omit<EvidenceEntry, 'id' | 'observedAt'> & { id?: string; observedAt?: string }): EvidenceEntry {
        const normalized = {
            ...entry,
            source: entry.source.trim(),
            query: entry.query?.trim() || undefined,
            citation: entry.citation?.trim() || undefined
        };
        if (!normalized.source) throw new Error('evidence source must be non-empty');
        const id = entry.id ?? evidenceId(normalized);
        const stored: EvidenceEntry = {
            id,
            toolName: normalized.toolName,
            ...(normalized.query ? { query: normalized.query } : {}),
            source: normalized.source,
            ...(normalized.chunkId ? { chunkId: normalized.chunkId } : {}),
            ...(normalized.citation ? { citation: normalized.citation } : {}),
            truncated: normalized.truncated,
            observedAt: entry.observedAt ?? this.now().toISOString()
        };
        this.entries.set(id, stored);
        return stored;
    }

    recordToolResult(toolName: string, result: ToolResult): EvidenceEntry[] {
        if (result.status !== 'success' || !isRagTool(toolName) || !result.data || typeof result.data !== 'object') {
            return [];
        }
        const data = result.data as Record<string, unknown>;
        const query = typeof data.query === 'string' ? data.query : undefined;
        const truncated = result.metadata?.truncated === true;
        const items = [
            ...(Array.isArray(data.matches) ? data.matches : []),
            ...(Array.isArray(data.chunks) ? data.chunks : [])
        ];
        return items.flatMap(item => {
            if (!item || typeof item !== 'object') return [];
            const value = item as Record<string, unknown>;
            const source = typeof value.source === 'string'
                ? value.source
                : typeof data.notePath === 'string'
                    ? data.notePath
                    : undefined;
            if (!source) return [];
            return [this.record({
                toolName,
                query,
                source,
                chunkId: typeof value.chunkId === 'string' ? value.chunkId : undefined,
                citation: typeof value.citation === 'string' ? value.citation : source,
                truncated
            })];
        });
    }

    assess(requirements: EvidenceRequirements = {}): EvidenceAssessment {
        return assessEvidence(this.list(), requirements);
    }

    list(): EvidenceEntry[] {
        return [...this.entries.values()];
    }

    clear(): void {
        this.entries.clear();
    }
}

export function assessEvidence(
    entries: readonly EvidenceEntry[],
    requirements: EvidenceRequirements = {}
): EvidenceAssessment {
    const minItems = requirements.minItems ?? 1;
    const minDistinctSources = requirements.minDistinctSources ?? 1;
    const requireCitation = requirements.requireCitation ?? true;
    const allowTruncated = requirements.allowTruncated ?? true;
    const distinctSources = new Set(entries.map(entry => entry.source)).size;
    const citedCount = entries.filter(entry => entry.citation).length;
    const truncatedCount = entries.filter(entry => entry.truncated).length;
    const expectedSources = requirements.expectedSources ?? [];
    const expectedHit = expectedSources.length === 0 || entries.some(entry =>
        expectedSources.some(expected => entry.source.toLowerCase().includes(expected.toLowerCase()))
    );
    const reasons: string[] = [];
    if (entries.length < minItems) reasons.push(`需要至少 ${minItems} 条证据，当前 ${entries.length} 条`);
    if (distinctSources < minDistinctSources) reasons.push(`需要至少 ${minDistinctSources} 个来源，当前 ${distinctSources} 个`);
    if (requireCitation && citedCount < entries.length) reasons.push('部分证据缺少可引用位置');
    if (!allowTruncated && truncatedCount > 0) reasons.push('存在被截断、需要重新读取的证据');
    if (!expectedHit) reasons.push('未命中任务要求的来源');
    const state: EvidenceSufficiency = entries.length === 0
        ? 'insufficient'
        : reasons.length === 0
            ? 'sufficient'
            : 'partial';
    return { state, reasons, evidenceCount: entries.length, distinctSources, citedCount, truncatedCount };
}

function isRagTool(toolName: string): boolean {
    return ['search_notes', 'grep_notes', 'read_note', 'related_notes'].some(name =>
        toolName === name || toolName.endsWith(`_${name}`)
    );
}

function evidenceId(entry: {
    toolName: string;
    query?: string;
    source: string;
    chunkId?: string;
    citation?: string;
}): string {
    return createHash('sha256')
        .update(JSON.stringify([entry.toolName, entry.query, entry.source, entry.chunkId, entry.citation]))
        .digest('hex')
        .slice(0, 24);
}
