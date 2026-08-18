export type TrajectoryBudget = {
    maxSnapshots: number;
    maxGoals: number;
    maxFacts: number;
    maxEvidenceReferences: number;
    maxFailedAttempts: number;
    maxIncompleteItems: number;
    maxToolCalls: number;
    maxConversationNotes: number;
    maxFieldChars: number;
};

export const DEFAULT_TRAJECTORY_BUDGET: TrajectoryBudget = {
    maxSnapshots: 4,
    maxGoals: 6,
    maxFacts: 20,
    maxEvidenceReferences: 24,
    maxFailedAttempts: 12,
    maxIncompleteItems: 12,
    maxToolCalls: 30,
    maxConversationNotes: 16,
    maxFieldChars: 320
};

export function clampText(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function keepLatestUnique(values: readonly string[], limit: number): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (let index = values.length - 1; index >= 0 && result.length < limit; index -= 1) {
        const value = values[index];
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.unshift(value);
    }
    return result;
}
