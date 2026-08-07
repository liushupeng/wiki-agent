import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeSourceConfig, loadKnowledgeSourceConfigs } from '../rag/sourceRoots.js';

export type EvaluationMode = 'raw-only' | 'raw-wiki';

export type EvaluationExperiment = {
    mode: EvaluationMode;
    indexProfile: string;
    indexVariant: string;
    wikiFirst: boolean;
};

const EXPERIMENTS: Record<EvaluationMode, Omit<EvaluationExperiment, 'mode'>> = {
    'raw-only': {
        indexProfile: 'bm25-v1',
        indexVariant: 'raw-only',
        wikiFirst: false
    },
    'raw-wiki': {
        indexProfile: 'bm25-v1',
        indexVariant: 'raw-wiki',
        wikiFirst: true
    }
};

export function getEvaluationExperiment(mode: EvaluationMode): EvaluationExperiment {
    const experiment = EXPERIMENTS[mode];
    return { mode, ...experiment };
}

export function parseEvaluationMode(value: string | undefined, defaultMode: EvaluationMode | 'both' = 'both'): EvaluationMode[] {
    const mode = (value ?? defaultMode).toLowerCase();
    if (mode === 'both') return ['raw-only', 'raw-wiki'];
    if (mode === 'raw-only' || mode === 'raw-wiki') return [mode];
    throw new Error(`unsupported evaluation mode "${mode}"; expected raw-only, raw-wiki, or both`);
}

export type SourceConfigIdentity = {
    path: string;
    fingerprint: string;
    sources: Array<Pick<KnowledgeSourceConfig, 'name' | 'root' | 'kind' | 'enabled' | 'index' | 'priority' | 'ignore'>>;
};

export async function getSourceConfigIdentity(configPath: string): Promise<SourceConfigIdentity> {
    const resolvedPath = path.resolve(configPath);
    const sources = await loadKnowledgeSourceConfigs(resolvedPath);
    const identitySources = sources.map(source => ({
        name: source.name,
        root: source.root,
        kind: source.kind,
        ...(source.enabled === undefined ? {} : { enabled: source.enabled }),
        ...(source.index === undefined ? {} : { index: source.index }),
        ...(source.priority === undefined ? {} : { priority: source.priority }),
        ignore: source.ignore ?? []
    }));
    return {
        path: resolvedPath,
        fingerprint: fingerprintSourceConfig(identitySources),
        sources: identitySources
    };
}

export function fingerprintSourceConfig(value: unknown): string {
    return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
        .join(',')}}`;
}
