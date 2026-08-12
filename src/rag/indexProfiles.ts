import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';

export const DEFAULT_RAG_INDEXES_CONFIG_PATH = 'config/rag.indexes.jsonc';

export type TfEmbeddingProfile = {
    type: 'tf';
};

export type Bm25EmbeddingProfile = {
    type: 'bm25';
    k1?: number;
    b?: number;
};

export type OpenAiCompatibleEmbeddingProfile = {
    type: 'openai-compatible';
    baseUrlEnv: string;
    apiKeyEnv: string;
    model: string;
    dimensions: number;
};

export type TransformersJsEmbeddingProfile = {
    type: 'transformers-js';
    model: string;
    revision?: string;
    dtype?: string;
    device?: 'cpu' | 'webgpu';
    dimensions: number;
    pooling?: 'cls' | 'mean';
    maxLength?: number;
    batchSize?: number;
    cacheDir?: string;
};

export type EmbeddingProfile =
    | TfEmbeddingProfile
    | Bm25EmbeddingProfile
    | OpenAiCompatibleEmbeddingProfile
    | TransformersJsEmbeddingProfile;

export type RagIndexProfile = {
    id: string;
    store: 'json' | 'lancedb';
    chunkSize: number;
    overlap: number;
    embedder: EmbeddingProfile;
    variants: RagIndexVariant[];
};

export type RagIndexVariant = {
    id: string;
    sourceConfigPath: string;
};

export type RagIndexesConfig = {
    indexDirectory: string;
    activeProfile: string;
    activeVariant: string;
    profiles: RagIndexProfile[];
};

export type IndexPaths = {
    directory: string;
    dataPath: string;
    manifestPath: string;
};

export async function loadRagIndexesConfig(
    configPath = process.env.RAG_INDEXES_CONFIG_PATH ?? DEFAULT_RAG_INDEXES_CONFIG_PATH
): Promise<RagIndexesConfig> {
    const resolvedPath = path.resolve(configPath);
    const value = parseJsonc(await fs.readFile(resolvedPath, 'utf-8'), `RAG indexes config file "${resolvedPath}"`);
    return parseRagIndexesConfig(value);
}

export function parseRagIndexesConfig(value: unknown): RagIndexesConfig {
    if (!isRecord(value) || !Array.isArray(value.profiles)) {
        throw new Error('RAG indexes config must contain a "profiles" array');
    }
    const indexDirectory = readNonEmptyString(value.indexDirectory, 'indexDirectory');
    const activeProfile = readId(value.activeProfile, 'activeProfile');
    const activeVariant = readId(value.activeVariant, 'activeVariant');
    const profiles = value.profiles.map((item, index) => parseProfile(item, index));
    const ids = new Set<string>();
    for (const profile of profiles) {
        if (ids.has(profile.id)) throw new Error(`duplicate RAG index profile: ${profile.id}`);
        ids.add(profile.id);
    }
    if (!ids.has(activeProfile)) throw new Error(`active RAG index profile does not exist: ${activeProfile}`);
    if (!profiles.find(profile => profile.id === activeProfile)?.variants.some(variant => variant.id === activeVariant)) {
        throw new Error(`active RAG index variant does not exist in profile ${activeProfile}: ${activeVariant}`);
    }
    return { indexDirectory, activeProfile, activeVariant, profiles };
}

export function resolveRagIndexProfile(config: RagIndexesConfig, profileId = config.activeProfile): RagIndexProfile {
    const profile = config.profiles.find(item => item.id === profileId);
    if (!profile) throw new Error(`unknown RAG index profile: ${profileId}`);
    return profile;
}

export function resolveRagIndexVariant(profile: RagIndexProfile, variantId: string): RagIndexVariant {
    const variant = profile.variants.find(item => item.id === variantId);
    if (!variant) throw new Error(`unknown RAG index variant for profile ${profile.id}: ${variantId}`);
    return variant;
}

export function getIndexPaths(profile: RagIndexProfile, variant: RagIndexVariant, baseDirectory: string): IndexPaths {
    const directory = path.resolve(baseDirectory, profile.id, variant.id);
    return {
        directory,
        dataPath: path.join(directory, profile.store === 'lancedb' ? 'index.lance' : 'index.json'),
        manifestPath: path.join(directory, 'manifest.json')
    };
}

export function fingerprintProfile(profile: RagIndexProfile): string {
    return createHash('sha256').update(stableSerialize(profile)).digest('hex');
}

function parseProfile(value: unknown, index: number): RagIndexProfile {
    if (!isRecord(value)) throw new Error(`RAG index profile at index ${index} must be an object`);
    const id = readId(value.id, `RAG index profile at index ${index} id`);
    if (value.store !== 'json' && value.store !== 'lancedb') {
        throw new Error(`RAG index profile "${id}" store must be "json" or "lancedb"`);
    }
    const chunkSize = readPositiveInteger(value.chunkSize, `RAG index profile "${id}" chunkSize`);
    const overlap = readNonNegativeInteger(value.overlap, `RAG index profile "${id}" overlap`);
    if (overlap >= chunkSize) throw new Error(`RAG index profile "${id}" overlap must be smaller than chunkSize`);
    const variants = parseVariants(value.variants, id);
    return { id, store: value.store, chunkSize, overlap, embedder: parseEmbedderProfile(value.embedder, id), variants };
}

function parseVariants(value: unknown, profileId: string): RagIndexVariant[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`RAG index profile "${profileId}" must contain a non-empty variants array`);
    const ids = new Set<string>();
    return value.map((item, index) => {
        if (!isRecord(item)) throw new Error(`RAG index profile "${profileId}" variant at index ${index} must be an object`);
        const id = readId(item.id, `RAG index profile "${profileId}" variant at index ${index} id`);
        if (ids.has(id)) throw new Error(`duplicate RAG index variant for profile ${profileId}: ${id}`);
        ids.add(id);
        return {
            id,
            sourceConfigPath: readNonEmptyString(item.sourceConfigPath, `RAG index profile "${profileId}" variant "${id}" sourceConfigPath`)
        };
    });
}

function parseEmbedderProfile(value: unknown, profileId: string): EmbeddingProfile {
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error(`RAG index profile "${profileId}" embedder must be an object with a type`);
    }
    if (value.type === 'tf') return { type: 'tf' };
    if (value.type === 'bm25') {
        const k1 = value.k1 === undefined ? undefined : readPositiveNumber(value.k1, `RAG index profile "${profileId}" embedder k1`);
        const b = value.b === undefined ? undefined : readUnitInterval(value.b, `RAG index profile "${profileId}" embedder b`);
        return {
            type: 'bm25',
            ...(k1 === undefined ? {} : { k1 }),
            ...(b === undefined ? {} : { b })
        };
    }
    if (value.type === 'openai-compatible') {
        return {
            type: 'openai-compatible',
            baseUrlEnv: readNonEmptyString(value.baseUrlEnv, `RAG index profile "${profileId}" embedder baseUrlEnv`),
            apiKeyEnv: readNonEmptyString(value.apiKeyEnv, `RAG index profile "${profileId}" embedder apiKeyEnv`),
            model: readNonEmptyString(value.model, `RAG index profile "${profileId}" embedder model`),
            dimensions: readPositiveInteger(value.dimensions, `RAG index profile "${profileId}" embedder dimensions`)
        };
    }
    if (value.type === 'transformers-js') {
        const device = value.device === undefined
            ? undefined
            : readEnum(value.device, ['cpu', 'webgpu'] as const, `RAG index profile "${profileId}" embedder device`);
        const pooling = value.pooling === undefined
            ? undefined
            : readEnum(value.pooling, ['cls', 'mean'] as const, `RAG index profile "${profileId}" embedder pooling`);
        return {
            type: 'transformers-js',
            model: readNonEmptyString(value.model, `RAG index profile "${profileId}" embedder model`),
            dimensions: readPositiveInteger(value.dimensions, `RAG index profile "${profileId}" embedder dimensions`),
            ...(value.revision === undefined ? {} : { revision: readNonEmptyString(value.revision, `RAG index profile "${profileId}" embedder revision`) }),
            ...(value.dtype === undefined ? {} : { dtype: readNonEmptyString(value.dtype, `RAG index profile "${profileId}" embedder dtype`) }),
            ...(device === undefined ? {} : { device }),
            ...(pooling === undefined ? {} : { pooling }),
            ...(value.maxLength === undefined ? {} : { maxLength: readPositiveInteger(value.maxLength, `RAG index profile "${profileId}" embedder maxLength`) }),
            ...(value.batchSize === undefined ? {} : { batchSize: readPositiveInteger(value.batchSize, `RAG index profile "${profileId}" embedder batchSize`) }),
            ...(value.cacheDir === undefined ? {} : { cacheDir: readNonEmptyString(value.cacheDir, `RAG index profile "${profileId}" embedder cacheDir`) })
        };
    }
    throw new Error(`unsupported embedding type for RAG index profile "${profileId}": ${value.type}`);
}

function readEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new Error(`${label} must be one of ${values.join(', ')}`);
    }
    return value as T;
}

function readId(value: unknown, label: string): string {
    const id = readNonEmptyString(value, label);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
    return id;
}

function readPositiveInteger(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
    return value as number;
}

function readNonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
    return value as number;
}

function readPositiveNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
    return value;
}

function readUnitInterval(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
    return value;
}

function readNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (!isRecord(value)) return JSON.stringify(value);
    return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
        .join(',')}}`;
}
