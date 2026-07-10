export type ParseJsonResult =
    | { ok: true; value: unknown }
    | { ok: false; error: string };

export function parseJsonSafely(value: string): ParseJsonResult {
    try {
        return { ok: true, value: JSON.parse(value) };
    } catch (error: any) {
        return { ok: false, error: error.message };
    }
}

export function parseToolArguments(argsStr: string): ParseJsonResult {
    return parseJsonSafely(argsStr.trim() ? argsStr : '{}');
}

export function parseJsonForTrace(value: string): unknown {
    const parsed = parseJsonSafely(value);
    return parsed.ok ? parsed.value : `invalid JSON: ${value}`;
}
