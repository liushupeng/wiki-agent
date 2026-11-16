import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonSafely } from '../utils/json.js';

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

export type RunArtifactInput = {
    traceId: string;
    instruction: string;
    finalAnswer: string;
    model: string;
    buildId?: string;
    terminationReason: string;
    finalAnswerAction?: string;
    evidence: {
        state: string;
        count: number;
        distinctSources: number;
        citedCount: number;
    };
};

export type RunArtifactReference = PromptArtifactReference;

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

export async function writeRunArtifact(
    input: RunArtifactInput,
    artifactDir = 'var/traces/run-artifacts'
): Promise<RunArtifactReference> {
    const relativeDirectory = path.relative(process.cwd(), path.resolve(artifactDir)) || '.';
    const safePayload = redactSensitiveValues({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        traceId: input.traceId,
        request: {
            instruction: input.instruction
        },
        response: {
            answer: input.finalAnswer,
            terminationReason: input.terminationReason,
            finalAnswerAction: input.finalAnswerAction
        },
        runtime: {
            model: input.model,
            buildId: input.buildId,
            evidence: input.evidence
        }
    });
    const content = `${JSON.stringify(safePayload, null, 2)}\n`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fileName = `run-${input.traceId}-${randomUUID()}.json`;
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

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 512;

export function buildToolArgumentTraceAttributes(rawArguments: string): Record<string, string | boolean> {
    const parsed = parseJsonSafely(rawArguments);
    const safeValue = parsed.ok ? redactSensitiveValues(parsed.value) : '[invalid JSON arguments]';
    const serialized = JSON.stringify(safeValue);
    return {
        'tool.arguments.preview': serialized.length > TOOL_ARGUMENT_PREVIEW_MAX_CHARS
            ? `${serialized.slice(0, TOOL_ARGUMENT_PREVIEW_MAX_CHARS)}...`
            : serialized,
        'tool.arguments.sha256': createHash('sha256').update(rawArguments).digest('hex'),
        'tool.arguments.truncated': serialized.length > TOOL_ARGUMENT_PREVIEW_MAX_CHARS
    };
}
