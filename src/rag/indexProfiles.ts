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

export type EmbeddingProfile = TfEmbeddingProfile | Bm25EmbeddingProfile | OpenAiCompatibleEmbeddingProfile;

export type RagIndexProfile = {
    id: string;
    store: 'json';
    chunkSize: number;
    overlap: number;
    embedder: EmbeddingProfile;
};

export type RagIndexesConfig = {
    indexDirectory: string;
    activeProfile: string;
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
    const profiles = value.profiles.map((item, index) => parseProfile(item, index));
    const ids = new Set<string>();
    for (const profile of profiles) {
        if (ids.has(profile.id)) throw new Error(`duplicate RAG index profile: ${profile.id}`);
        ids.add(profile.id);
    }
    if (!ids.has(activeProfile)) throw new Error(`active RAG index profile does not exist: ${activeProfile}`);
    return { indexDirectory, activeProfile, profiles };
}

export function resolveRagIndexProfile(config: RagIndexesConfig, profileId = config.activeProfile): RagIndexProfile {
    const profile = config.profiles.find(item => item.id === profileId);
    if (!profile) throw new Error(`unknown RAG index profile: ${profileId}`);
    return profile;
}

export function getIndexPaths(profile: RagIndexProfile, baseDirectory: string): IndexPaths {
    const directory = path.resolve(baseDirectory, profile.id);
    return {
        directory,
        dataPath: path.join(directory, 'index.json'),
        manifestPath: path.join(directory, 'manifest.json')
    };
}

export function fingerprintProfile(profile: RagIndexProfile): string {
    return createHash('sha256').update(stableSerialize(profile)).digest('hex');
}

function parseProfile(value: unknown, index: number): RagIndexProfile {
    if (!isRecord(value)) throw new Error(`RAG index profile at index ${index} must be an object`);
    const id = readId(value.id, `RAG index profile at index ${index} id`);
    if (value.store !== 'json') throw new Error(`RAG index profile "${id}" store must be "json"`);
    const chunkSize = readPositiveInteger(value.chunkSize, `RAG index profile "${id}" chunkSize`);
    const overlap = readNonNegativeInteger(value.overlap, `RAG index profile "${id}" overlap`);
    if (overlap >= chunkSize) throw new Error(`RAG index profile "${id}" overlap must be smaller than chunkSize`);
    return { id, store: 'json', chunkSize, overlap, embedder: parseEmbedderProfile(value.embedder, id) };
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
    throw new Error(`unsupported embedding type for RAG index profile "${profileId}": ${value.type}`);
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
