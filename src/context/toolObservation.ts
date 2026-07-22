import { ToolResult } from '../types.js';

const DEFAULT_CONTEXT_TOOL_RESULT_MAX_CHARS = 6_000;
const MAX_OBJECT_KEYS = 12;
const MAX_ARRAY_ITEMS = 5;
const MAX_STRING_CHARS = 800;

export type ToolObservation = {
    content: string;
    originalChars: number;
    contextChars: number;
    truncated: boolean;
};

export function buildToolObservation(
    result: ToolResult,
    maxChars = getContextToolResultMaxChars()
): ToolObservation {
    const original = serialize(result);
    if (original.length <= maxChars) {
        return {
            content: original,
            originalChars: original.length,
            contextChars: original.length,
            truncated: false
        };
    }

    const compacted = {
        status: result.status,
        ...(result.error ? { error: truncateText(result.error, MAX_STRING_CHARS) } : {}),
        ...(result.data !== undefined ? { data: compactValue(result.data) } : {}),
        ...(result.metadata ? { metadata: compactValue(result.metadata) } : {}),
        context: {
            truncated: true,
            originalChars: original.length,
            maxChars,
            hint: 'Tool result was compacted before being sent to the model. Use narrower arguments or another tool if more detail is needed.'
        }
    };
    const compactedText = serialize(compacted);
    if (compactedText.length <= maxChars) {
        return {
            content: compactedText,
            originalChars: original.length,
            contextChars: compactedText.length,
            truncated: true
        };
    }

    const fallback = {
        status: result.status,
        ...(result.error ? { error: truncateText(result.error, 400) } : {}),
        context: {
            truncated: true,
            originalChars: original.length,
            maxChars,
            hint: 'Tool result omitted; retry with narrower arguments.'
        }
    };
    const content = buildBoundedPreview(fallback, original, maxChars);
    return {
        content,
        originalChars: original.length,
        contextChars: content.length,
        truncated: true
    };
}

function buildBoundedPreview(fallback: object, original: string, maxChars: number): string {
    let low = 0;
    let high = original.length;
    let content = serialize({ ...fallback, dataPreview: '' });

    while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const candidate = serialize({
            ...fallback,
            dataPreview: truncateText(original, length)
        });
        if (candidate.length <= maxChars) {
            content = candidate;
            low = length + 1;
        } else {
            high = length - 1;
        }
    }

    return content;
}

export function getContextToolResultMaxChars(): number {
    const configured = Number(process.env.CONTEXT_TOOL_RESULT_MAX_CHARS);
    return Number.isFinite(configured) && configured > 0
        ? Math.max(512, Math.floor(configured))
        : DEFAULT_CONTEXT_TOOL_RESULT_MAX_CHARS;
}

function compactValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return truncateText(value, MAX_STRING_CHARS);
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => compactValue(item, depth + 1));
        return value.length > MAX_ARRAY_ITEMS
            ? [...items, `[${value.length - MAX_ARRAY_ITEMS} items omitted]`]
            : items;
    }
    if (!value || typeof value !== 'object') return value;
    if (depth >= 3) return truncateText(serialize(value), MAX_STRING_CHARS);

    const entries = Object.entries(value as Record<string, unknown>);
    const compacted = Object.fromEntries(entries
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, item]) => [key, compactValue(item, depth + 1)]));
    if (entries.length > MAX_OBJECT_KEYS) {
        compacted._omittedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return compacted;
}

function truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars))}[truncated]`;
}

function serialize(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({
            status: 'runtime_error',
            error: 'tool result could not be serialized'
        });
    }
}
