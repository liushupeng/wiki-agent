import fs from 'fs/promises';
import path from 'path';
import { parseJsonc } from '../utils/jsonc.js';

export const DEFAULT_KNOWLEDGE_SOURCES_CONFIG_PATH = 'config/knowledge.sources.jsonc';
export const KNOWLEDGE_SOURCE_KINDS = ['wiki', 'raw', 'code', 'data'] as const;
export type KnowledgeSourceKind = typeof KNOWLEDGE_SOURCE_KINDS[number];

export type KnowledgeSourceConfig = {
    name: string;
    root: string;
    kind: KnowledgeSourceKind;
    enabled?: boolean;
    index?: boolean;
    priority?: number;
    ignore?: string[];
};

export type KnowledgeSourceRoot = {
    prefix: string;
    root: string;
    kind: KnowledgeSourceKind;
    priority: number;
    ignore: string[];
};

/**
 * 多知识源配置入口。
 *
 * 默认读取 config/knowledge.sources.jsonc。可以用 KNOWLEDGE_SOURCES_CONFIG_PATH
 * 指向其他 JSONC 文件，方便本地真实知识库使用不同配置。
 */
export async function getKnowledgeSourceRoots(env: Record<string, string | undefined> = process.env): Promise<KnowledgeSourceRoot[]> {
    return loadKnowledgeSourceRoots(env.KNOWLEDGE_SOURCES_CONFIG_PATH ?? DEFAULT_KNOWLEDGE_SOURCES_CONFIG_PATH);
}

export async function loadKnowledgeSourceRoots(configPath: string): Promise<KnowledgeSourceRoot[]> {
    const configs = await loadKnowledgeSourceConfigs(configPath);
    return configs
        .filter(config => config.enabled !== false && config.index !== false)
        .map(configToRoot)
        .sort((left, right) => right.priority - left.priority || left.prefix.localeCompare(right.prefix));
}

export async function loadKnowledgeSourceConfigs(configPath: string): Promise<KnowledgeSourceConfig[]> {
    const resolvedPath = path.resolve(configPath);
    const parsed = parseJsonc(
        await fs.readFile(resolvedPath, 'utf-8'),
        `knowledge sources config file "${resolvedPath}"`
    );
    return parseKnowledgeSourceConfigs(parsed);
}

export function parseKnowledgeSourceConfigs(value: unknown): KnowledgeSourceConfig[] {
    const entries = readKnowledgeSourceEntries(value);
    if (!entries) throw new Error('knowledge sources config must contain a "sources" array');
    const configs = entries.map((entry, index) => parseKnowledgeSourceConfig(entry, index));
    const names = new Set<string>();

    for (const config of configs) {
        const normalizedName = normalizePrefix(config.name).toLowerCase();
        if (names.has(normalizedName)) throw new Error(`duplicate knowledge source name: ${config.name}`);
        names.add(normalizedName);
    }

    return configs;
}

function readKnowledgeSourceEntries(value: unknown): unknown[] | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const sources = (value as Record<string, unknown>).sources;
    return Array.isArray(sources) ? sources : undefined;
}

export function sourceWithPrefix(prefix: string, relativeSource: string): string {
    return [normalizePrefix(prefix), relativeSource.replace(/\\/g, '/')]
        .filter(Boolean)
        .join('/');
}

export function isWikiSource(source: string): boolean {
    return source.replace(/\\/g, '/').toLowerCase().startsWith('wiki/');
}

function parseKnowledgeSourceConfig(value: unknown, index: number): KnowledgeSourceConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`knowledge source at index ${index} must be an object`);
    }

    const item = value as Record<string, unknown>;
    const name = readNonEmptyString(item.name, `knowledge source at index ${index} name`);
    const root = readNonEmptyString(item.root, `knowledge source "${name}" root`);
    const kind = readKind(item.kind, name);

    return {
        name: normalizePrefix(name),
        root,
        kind,
        ...(item.enabled !== undefined ? { enabled: readBoolean(item.enabled, `knowledge source "${name}" enabled`) } : {}),
        ...(item.index !== undefined ? { index: readBoolean(item.index, `knowledge source "${name}" index`) } : {}),
        ...(item.priority !== undefined ? { priority: readNumber(item.priority, `knowledge source "${name}" priority`) } : {}),
        ignore: readStringArray(item.ignore, `knowledge source "${name}" ignore`)
    };
}

function configToRoot(config: KnowledgeSourceConfig): KnowledgeSourceRoot {
    return {
        prefix: normalizePrefix(config.name),
        root: config.root,
        kind: config.kind,
        priority: config.priority ?? defaultPriorityForKind(config.kind),
        ignore: config.ignore ?? []
    };
}

function defaultPriorityForKind(kind: KnowledgeSourceKind): number {
    if (kind === 'wiki') return 100;
    if (kind === 'raw') return 50;
    return 10;
}

function normalizePrefix(prefix: string): string {
    return prefix.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function readNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    return value.trim();
}

function readKind(value: unknown, name: string): KnowledgeSourceKind {
    if (typeof value !== 'string' || !(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(value)) {
        throw new Error(`knowledge source "${name}" kind must be one of: ${KNOWLEDGE_SOURCE_KINDS.join(', ')}`);
    }

    return value as KnowledgeSourceKind;
}

function readBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    return value;
}

function readNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
    return value;
}

function readStringArray(value: unknown, label: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${label} must be an array of strings`);
    }

    return value.map(item => item.trim()).filter(Boolean);
}
