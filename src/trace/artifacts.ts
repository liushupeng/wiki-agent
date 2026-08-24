import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SENSITIVE_KEY_PATTERN = /api[-_]?key|authorization|cookie|password|secret|token/i;
const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
    [/\b(authorization\s*:\s*bearer)\s+[^\s"'`]+/gi, '$1 [REDACTED]'],
    [/\bsk-[a-z0-9_-]{10,}\b/gi, '[REDACTED]'],
    [/\b(api[-_]?key|password|secret|token)\s*[:=]\s*["']?[^\s"',;]+["']?/gi, '$1=[REDACTED]']
];

export type PromptArtifactInput = {
    traceId: string;
    spanId: string;
    model: string;
    temperature: number;
    reasoningEffort: string;
    messages: unknown;
    tools: unknown;
};

export type PromptArtifactReference = {
    path: string;
    sha256: string;
    chars: number;
};

export async function writePromptArtifact(
    input: PromptArtifactInput,
    artifactDir = 'var/traces/artifacts'
): Promise<PromptArtifactReference> {
    const relativeDirectory = path.relative(process.cwd(), path.resolve(artifactDir)) || '.';
    const safePayload = redactSensitiveValues({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        traceId: input.traceId,
        spanId: input.spanId,
        request: {
            model: input.model,
            temperature: input.temperature,
            reasoningEffort: input.reasoningEffort,
            messages: input.messages,
            tools: input.tools
        }
    });
    const content = `${JSON.stringify(safePayload, null, 2)}\n`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fileName = `prompt-${input.traceId}-${input.spanId}-${randomUUID()}.json`;
    const absoluteDirectory = path.resolve(artifactDir);
    const absolutePath = path.join(absoluteDirectory, fileName);
    const temporaryPath = `${absolutePath}.tmp`;

    await fs.mkdir(absoluteDirectory, { recursive: true });
    try {
        await fs.writeFile(temporaryPath, content, { encoding: 'utf-8', flag: 'wx' });
        await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }

    return {
        path: path.posix.join(relativeDirectory.replace(/\\/g, '/'), fileName),
        sha256,
        chars: content.length
    };
}

export function redactSensitiveValues(value: unknown, key = ''): unknown {
    if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(item => redactSensitiveValues(item));
    if (typeof value === 'string') return redactSensitiveText(value);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, redactSensitiveValues(entryValue, entryKey)]));
}

export function redactSensitiveText(value: string): string {
    return SENSITIVE_TEXT_PATTERNS.reduce(
        (text, [pattern, replacement]) => text.replace(pattern, replacement),
        value
    );
}
