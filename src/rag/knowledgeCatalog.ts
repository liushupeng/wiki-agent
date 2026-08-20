import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseJsonc } from '../utils/jsonc.js';
import type { TextChunk } from './types.js';

export const KNOWLEDGE_STATUSES = ['active', 'superseded', 'archived', 'quarantined', 'deleted'] as const;
export type KnowledgeStatus = typeof KNOWLEDGE_STATUSES[number];
export const KNOWLEDGE_AUTHORITY_LEVELS = ['high', 'normal', 'low'] as const;
export type KnowledgeAuthority = typeof KNOWLEDGE_AUTHORITY_LEVELS[number];
export const KNOWLEDGE_CONSISTENCY_STATES = ['clear', 'conditional', 'conflicted', 'unknown'] as const;
export type KnowledgeConsistencyStatus = typeof KNOWLEDGE_CONSISTENCY_STATES[number];

export type KnowledgeCatalogRecord = {
    sourceId: string;
    versionId: string;
    status: KnowledgeStatus;
    authority: KnowledgeAuthority;
    quality: number;
    consistencyStatus: KnowledgeConsistencyStatus;
    validFrom?: string;
    validTo?: string;
    supersededBy?: string;
    contentHash?: string;
    claims?: KnowledgeClaimRecord[];
};

export type KnowledgeClaimRecord = {
    claimId: string;
    entity: string;
    metric: string;
    value: string | number;
    asOf?: string;
    scenario?: string;
    method?: string;
    chapter?: string;
    assumption?: string;
};

export type KnowledgeCatalogData = {
    version: 1;
    records: KnowledgeCatalogRecord[];
};

export type KnowledgeCatalogIdentity = {
    path: string;
    sha256: string;
};

export class KnowledgeCatalog {
    private readonly recordsBySource: Map<string, KnowledgeCatalogRecord>;

    constructor(readonly data: KnowledgeCatalogData, readonly identity?: KnowledgeCatalogIdentity) {
        this.recordsBySource = new Map(data.records.map(record => [normalizeSource(record.sourceId), record]));
    }

    resolve(sourceId: string): KnowledgeCatalogRecord {
        return this.recordsBySource.get(normalizeSource(sourceId)) ?? {
            sourceId,
            versionId: 'unversioned',
            status: 'active',
            authority: 'normal',
            quality: 0.5,
            consistencyStatus: 'unknown'
        };
    }

    findClaims(query: {
        entity?: string;
        metric?: string;
        asOf?: string;
    }): Array<{ source: KnowledgeCatalogRecord; claim: KnowledgeClaimRecord }> {
        const normalizedEntity = query.entity?.trim().toLowerCase();
        const normalizedMetric = query.metric?.trim().toLowerCase();
        return this.data.records.flatMap(source => (source.claims ?? []).flatMap(claim => {
            if (normalizedEntity && claim.entity.toLowerCase() !== normalizedEntity) return [];
            if (normalizedMetric && claim.metric.toLowerCase() !== normalizedMetric) return [];
            if (query.asOf && claim.asOf !== query.asOf) return [];
            return [{ source, claim }];
        }));
    }

    shouldIndex(sourceId: string, now = new Date()): boolean {
        const record = this.resolve(sourceId);
        if (record.status !== 'active') return false;
        if (record.validFrom && new Date(record.validFrom) > now) return false;
        if (record.validTo && new Date(record.validTo) < now) return false;
        return true;
    }

    decorateChunk(chunk: TextChunk): TextChunk {
        const record = this.recordsBySource.get(normalizeSource(chunk.source));
        if (!record) return chunk;
        return {
            ...chunk,
            frontmatter: {
                ...(chunk.frontmatter ?? {}),
                knowledgeVersion: record.versionId,
                knowledgeStatus: record.status,
                knowledgeAuthority: record.authority,
                knowledgeQuality: String(record.quality),
                knowledgeConsistency: record.consistencyStatus,
                ...(record.validFrom ? { knowledgeValidFrom: record.validFrom } : {}),
                ...(record.validTo ? { knowledgeValidTo: record.validTo } : {}),
                ...(record.supersededBy ? { knowledgeSupersededBy: record.supersededBy } : {})
            }
        };
    }
}

export async function loadKnowledgeCatalog(
    catalogPath = process.env.KNOWLEDGE_CATALOG_PATH ?? 'config/knowledge.catalog.jsonc'
): Promise<KnowledgeCatalog> {
    const resolved = path.resolve(catalogPath);
    const raw = await fs.readFile(resolved, 'utf-8');
    const data = parseKnowledgeCatalog(parseJsonc(raw, `knowledge catalog "${resolved}"`));
    return new KnowledgeCatalog(data, {
        path: resolved,
        sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex')
    });
}

export function parseKnowledgeCatalog(value: unknown): KnowledgeCatalogData {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
        throw new Error('knowledge catalog must contain version=1 and a records array');
    }
    const records = value.records.map((record, index) => parseRecord(record, index));
    const sourceIds = new Set<string>();
    for (const record of records) {
        const normalized = normalizeSource(record.sourceId);
        if (sourceIds.has(normalized)) throw new Error(`duplicate knowledge sourceId: ${record.sourceId}`);
        sourceIds.add(normalized);
    }
    const knownVersions = new Set(records.map(record => record.versionId));
    for (const record of records) {
        if (record.status === 'superseded' && !record.supersededBy) {
            throw new Error(`superseded record requires supersededBy: ${record.sourceId}`);
        }
        if (record.supersededBy && !knownVersions.has(record.supersededBy)) {
            throw new Error(`unknown supersededBy version "${record.supersededBy}" for ${record.sourceId}`);
        }
    }
    return { version: 1, records };
}

function parseRecord(value: unknown, index: number): KnowledgeCatalogRecord {
    if (!isRecord(value)) throw new Error(`knowledge catalog record ${index} must be an object`);
    const sourceId = readString(value.sourceId, `records[${index}].sourceId`);
    const versionId = readString(value.versionId, `records[${index}].versionId`);
    const status = readChoice(value.status, KNOWLEDGE_STATUSES, `records[${index}].status`);
    const authority = readChoice(value.authority, KNOWLEDGE_AUTHORITY_LEVELS, `records[${index}].authority`);
    const quality = typeof value.quality === 'number' ? value.quality : Number.NaN;
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
        throw new Error(`records[${index}].quality must be between 0 and 1`);
    }
    const consistencyStatus = readChoice(
        value.consistencyStatus,
        KNOWLEDGE_CONSISTENCY_STATES,
        `records[${index}].consistencyStatus`
    );
    const validFrom = readOptionalDate(value.validFrom, `records[${index}].validFrom`);
    const validTo = readOptionalDate(value.validTo, `records[${index}].validTo`);
    if (validFrom && validTo && new Date(validFrom) > new Date(validTo)) {
        throw new Error(`records[${index}] validFrom must not be after validTo`);
    }
    const supersededBy = readOptionalString(value.supersededBy, `records[${index}].supersededBy`);
    const contentHash = readOptionalString(value.contentHash, `records[${index}].contentHash`);
    if (contentHash && !/^[a-f0-9]{64}$/i.test(contentHash)) {
        throw new Error(`records[${index}].contentHash must be a SHA-256 hex string`);
    }
    const claims = value.claims === undefined
        ? undefined
        : parseClaims(value.claims, `records[${index}].claims`);
    return {
        sourceId,
        versionId,
        status,
        authority,
        quality,
        consistencyStatus,
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
        ...(supersededBy ? { supersededBy } : {}),
        ...(contentHash ? { contentHash: contentHash.toLowerCase() } : {}),
        ...(claims ? { claims } : {})
    };
}

function parseClaims(value: unknown, label: string): KnowledgeClaimRecord[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const claimIds = new Set<string>();
    return value.map((claim, index) => {
        if (!isRecord(claim)) throw new Error(`${label}[${index}] must be an object`);
        const claimId = readString(claim.claimId, `${label}[${index}].claimId`);
        if (claimIds.has(claimId)) throw new Error(`duplicate claimId in ${label}: ${claimId}`);
        claimIds.add(claimId);
        if (typeof claim.value !== 'string' && typeof claim.value !== 'number') {
            throw new Error(`${label}[${index}].value must be a string or number`);
        }
        return {
            claimId,
            entity: readString(claim.entity, `${label}[${index}].entity`),
            metric: readString(claim.metric, `${label}[${index}].metric`),
            value: claim.value,
            ...(readOptionalDate(claim.asOf, `${label}[${index}].asOf`) ? { asOf: claim.asOf as string } : {}),
            ...(readOptionalString(claim.scenario, `${label}[${index}].scenario`) ? { scenario: claim.scenario as string } : {}),
            ...(readOptionalString(claim.method, `${label}[${index}].method`) ? { method: claim.method as string } : {}),
            ...(readOptionalString(claim.chapter, `${label}[${index}].chapter`) ? { chapter: claim.chapter as string } : {}),
            ...(readOptionalString(claim.assumption, `${label}[${index}].assumption`) ? { assumption: claim.assumption as string } : {})
        };
    });
}

function readChoice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) {
        throw new Error(`${label} must be one of: ${choices.join(', ')}`);
    }
    return value as T;
}

function readString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
    return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : readString(value, label);
}

function readOptionalDate(value: unknown, label: string): string | undefined {
    const text = readOptionalString(value, label);
    if (!text) return undefined;
    if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO date`);
    return text;
}

function normalizeSource(source: string): string {
    return source.replace(/\\/g, '/').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
