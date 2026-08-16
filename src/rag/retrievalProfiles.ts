import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';

export const DEFAULT_RAG_RETRIEVAL_CONFIG_PATH = 'config/rag.retrieval.jsonc';

export type RerankerProfile = {
    model: string;
    revision?: string;
    dtype?: string;
    device?: 'cpu' | 'webgpu';
    maxLength: number;
    batchSize: number;
    cacheDir?: string;
    scoreCacheDir?: string;
};

export type SingleRetrievalProfile = {
    id: string;
    mode: 'single';
    indexProfile: string;
    candidateLimit: number;
    rerankDocumentMode?: 'text' | 'metadata-prefixed';
    reranker?: RerankerProfile;
};

export type HybridRetrievalProfile = {
    id: string;
    mode: 'hybrid';
    sparseProfile: string;
    denseProfile: string;
    candidateLimitPerRetriever: number;
    fusionLimit: number;
    rrfK: number;
    chunkRerankLimit?: number;
    anchorLimit?: number;
    maxPerSource?: number;
    contextWindow?: number;
    candidateCacheDir?: string;
    rerankDocumentMode?: 'text' | 'metadata-prefixed';
    chunkRerankFusionWeight?: number;
    evidenceRerankFusionWeight?: number;
    sourceLocalSearch?: {
        sourceLimit: number;
        candidateLimitPerSource: number;
        chunksPerSource: number;
        rankingMode?: 'chunk-score' | 'source-preserving';
        anchorMode?: 'merge' | 'source-local-only';
    };
    stages?: {
        chunkRerank?: boolean;
        evidenceExpand?: boolean;
        evidenceRerank?: boolean;
        sourceLimit?: boolean;
    };
    reranker?: RerankerProfile;
};

export type RetrievalProfile = SingleRetrievalProfile | HybridRetrievalProfile;

export type RetrievalProfilesConfig = {
    activeRetrievalProfile: string;
    profiles: RetrievalProfile[];
};

export async function loadRetrievalProfilesConfig(
    configPath = process.env.RAG_RETRIEVAL_CONFIG_PATH ?? DEFAULT_RAG_RETRIEVAL_CONFIG_PATH
): Promise<RetrievalProfilesConfig> {
    const resolved = path.resolve(configPath);
    return parseRetrievalProfilesConfig(parseJsonc(await fs.readFile(resolved, 'utf-8'), `RAG retrieval config "${resolved}"`));
}

export function parseRetrievalProfilesConfig(value: unknown): RetrievalProfilesConfig {
    if (!isRecord(value) || !Array.isArray(value.profiles)) {
        throw new Error('RAG retrieval config must contain a profiles array');
    }
    const activeRetrievalProfile = readString(value.activeRetrievalProfile, 'activeRetrievalProfile');
    const profiles = value.profiles.map(parseProfile);
    const ids = new Set<string>();
    for (const profile of profiles) {
        if (ids.has(profile.id)) throw new Error(`duplicate retrieval profile: ${profile.id}`);
        ids.add(profile.id);
    }
    if (!ids.has(activeRetrievalProfile)) {
        throw new Error(`active retrieval profile does not exist: ${activeRetrievalProfile}`);
    }
    return { activeRetrievalProfile, profiles };
}

export function resolveRetrievalProfile(config: RetrievalProfilesConfig, id = config.activeRetrievalProfile): RetrievalProfile {
    const profile = config.profiles.find(item => item.id === id);
    if (!profile) throw new Error(`unknown retrieval profile: ${id}`);
    return profile;
}

function parseProfile(value: unknown, index: number): RetrievalProfile {
    if (!isRecord(value)) throw new Error(`retrieval profile at index ${index} must be an object`);
    const id = readId(value.id, `retrieval profile at index ${index} id`);
    const mode = readString(value.mode, `retrieval profile "${id}" mode`);
    if (mode === 'single') {
        const reranker = value.reranker === undefined ? undefined : parseReranker(value.reranker, id);
        return {
            id,
            mode,
            indexProfile: readId(value.indexProfile, `retrieval profile "${id}" indexProfile`),
            candidateLimit: readPositiveInteger(value.candidateLimit, `retrieval profile "${id}" candidateLimit`),
            ...(value.rerankDocumentMode === undefined ? {} : {
                rerankDocumentMode: readChoice(value.rerankDocumentMode, ['text', 'metadata-prefixed'], `retrieval profile "${id}" rerankDocumentMode`) as 'text' | 'metadata-prefixed'
            }),
            ...(reranker ? { reranker } : {})
        };
    }
    if (mode !== 'hybrid') throw new Error(`retrieval profile "${id}" mode must be single or hybrid`);
    const reranker = value.reranker === undefined ? undefined : parseReranker(value.reranker, id);
    const stages = value.stages === undefined ? undefined : parseStages(value.stages, id);
    const sourceLocalSearch = value.sourceLocalSearch === undefined
        ? undefined
        : parseSourceLocalSearch(value.sourceLocalSearch, id);
    return {
        id,
        mode,
        sparseProfile: readId(value.sparseProfile, `retrieval profile "${id}" sparseProfile`),
        denseProfile: readId(value.denseProfile, `retrieval profile "${id}" denseProfile`),
        candidateLimitPerRetriever: readPositiveInteger(value.candidateLimitPerRetriever, `retrieval profile "${id}" candidateLimitPerRetriever`),
        fusionLimit: readPositiveInteger(value.fusionLimit, `retrieval profile "${id}" fusionLimit`),
        rrfK: readPositiveInteger(value.rrfK, `retrieval profile "${id}" rrfK`),
        ...(value.chunkRerankLimit === undefined ? {} : { chunkRerankLimit: readPositiveInteger(value.chunkRerankLimit, `retrieval profile "${id}" chunkRerankLimit`) }),
        ...(value.anchorLimit === undefined ? {} : { anchorLimit: readPositiveInteger(value.anchorLimit, `retrieval profile "${id}" anchorLimit`) }),
        ...(value.maxPerSource === undefined ? {} : { maxPerSource: readPositiveInteger(value.maxPerSource, `retrieval profile "${id}" maxPerSource`) }),
        ...(value.contextWindow === undefined ? {} : { contextWindow: readNonNegativeInteger(value.contextWindow, `retrieval profile "${id}" contextWindow`) }),
        ...(value.candidateCacheDir === undefined ? {} : { candidateCacheDir: readString(value.candidateCacheDir, `retrieval profile "${id}" candidateCacheDir`) }),
        ...(value.rerankDocumentMode === undefined ? {} : {
            rerankDocumentMode: readChoice(value.rerankDocumentMode, ['text', 'metadata-prefixed'], `retrieval profile "${id}" rerankDocumentMode`) as 'text' | 'metadata-prefixed'
        }),
        ...(value.chunkRerankFusionWeight === undefined ? {} : { chunkRerankFusionWeight: readUnitInterval(value.chunkRerankFusionWeight, `retrieval profile "${id}" chunkRerankFusionWeight`) }),
        ...(value.evidenceRerankFusionWeight === undefined ? {} : { evidenceRerankFusionWeight: readUnitInterval(value.evidenceRerankFusionWeight, `retrieval profile "${id}" evidenceRerankFusionWeight`) }),
        ...(sourceLocalSearch ? { sourceLocalSearch } : {}),
        ...(stages ? { stages } : {}),
        ...(reranker ? { reranker } : {})
    };
}

function parseSourceLocalSearch(
    value: unknown,
    profileId: string
): NonNullable<HybridRetrievalProfile['sourceLocalSearch']> {
    if (!isRecord(value)) throw new Error(`retrieval profile "${profileId}" sourceLocalSearch must be an object`);
    return {
        sourceLimit: readPositiveInteger(value.sourceLimit, `retrieval profile "${profileId}" sourceLocalSearch.sourceLimit`),
        candidateLimitPerSource: readPositiveInteger(value.candidateLimitPerSource, `retrieval profile "${profileId}" sourceLocalSearch.candidateLimitPerSource`),
        chunksPerSource: readPositiveInteger(value.chunksPerSource, `retrieval profile "${profileId}" sourceLocalSearch.chunksPerSource`),
        ...(value.rankingMode === undefined ? {} : {
            rankingMode: readChoice(
                value.rankingMode,
                ['chunk-score', 'source-preserving'],
                `retrieval profile "${profileId}" sourceLocalSearch.rankingMode`
            ) as 'chunk-score' | 'source-preserving'
        }),
        ...(value.anchorMode === undefined ? {} : {
            anchorMode: readChoice(
                value.anchorMode,
                ['merge', 'source-local-only'],
                `retrieval profile "${profileId}" sourceLocalSearch.anchorMode`
            ) as 'merge' | 'source-local-only'
        })
    };
}

function parseStages(value: unknown, profileId: string): NonNullable<HybridRetrievalProfile['stages']> {
    if (!isRecord(value)) throw new Error(`retrieval profile "${profileId}" stages must be an object`);
    return {
        ...(value.chunkRerank === undefined ? {} : { chunkRerank: readBoolean(value.chunkRerank, 'stages.chunkRerank') }),
        ...(value.evidenceExpand === undefined ? {} : { evidenceExpand: readBoolean(value.evidenceExpand, 'stages.evidenceExpand') }),
        ...(value.evidenceRerank === undefined ? {} : { evidenceRerank: readBoolean(value.evidenceRerank, 'stages.evidenceRerank') }),
        ...(value.sourceLimit === undefined ? {} : { sourceLimit: readBoolean(value.sourceLimit, 'stages.sourceLimit') })
    };
}

function parseReranker(value: unknown, profileId: string): RerankerProfile {
    if (!isRecord(value)) throw new Error(`retrieval profile "${profileId}" reranker must be an object`);
    const device = value.device === undefined ? undefined : readChoice(value.device, ['cpu', 'webgpu'], 'reranker device');
    return {
        model: readString(value.model, `retrieval profile "${profileId}" reranker model`),
        maxLength: readPositiveInteger(value.maxLength, `retrieval profile "${profileId}" reranker maxLength`),
        batchSize: readPositiveInteger(value.batchSize, `retrieval profile "${profileId}" reranker batchSize`),
        ...(value.revision === undefined ? {} : { revision: readString(value.revision, 'reranker revision') }),
        ...(value.dtype === undefined ? {} : { dtype: readString(value.dtype, 'reranker dtype') }),
        ...(device ? { device: device as 'cpu' | 'webgpu' } : {}),
        ...(value.cacheDir === undefined ? {} : { cacheDir: readString(value.cacheDir, 'reranker cacheDir') }),
        ...(value.scoreCacheDir === undefined ? {} : { scoreCacheDir: readString(value.scoreCacheDir, 'reranker scoreCacheDir') })
    };
}

function readChoice(value: unknown, choices: string[], label: string): string {
    const result = readString(value, label);
    if (!choices.includes(result)) throw new Error(`${label} must be one of ${choices.join(', ')}`);
    return result;
}

function readId(value: unknown, label: string): string {
    const id = readString(value, label);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
    return id;
}

function readString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    return value.trim();
}

function readPositiveInteger(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
    return value as number;
}

function readNonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
    return value as number;
}

function readUnitInterval(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${label} must be a number between 0 and 1`);
    }
    return value;
}

function readBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
