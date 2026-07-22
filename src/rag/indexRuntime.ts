import fs from 'node:fs/promises';
import path from 'node:path';
import { Embedder, EmbeddingIdentity, createEmbedder } from './embeddings.js';
import {
    IndexPaths,
    RagIndexProfile,
    fingerprintProfile,
    getIndexPaths,
    loadRagIndexesConfig,
    resolveRagIndexProfile
} from './indexProfiles.js';
import { IndexedChunk, SearchResult } from './types.js';
import { VectorSearchScoring, VectorStore, createVectorStore } from './vectorStore.js';

export type IndexManifest = {
    version: 1;
    profileId: string;
    profileFingerprint: string;
    embedding: EmbeddingIdentity;
    store: string;
    dataFile: string;
    chunkSize: number;
    overlap: number;
    createdAt: string;
};

export type IndexRuntime = Pick<VectorStore, 'findBySource'> & {
    readonly profile: RagIndexProfile;
    readonly manifest: IndexManifest;
    readonly store: VectorStore;
    readonly embedder: Embedder;
    search(query: string, topK?: number): Promise<SearchResult[]>;
    findRelated(source: string, topK?: number): Promise<SearchResult[]>;
};

export async function openActiveIndex(profileId?: string): Promise<IndexRuntime> {
    const config = await loadRagIndexesConfig();
    const profile = resolveRagIndexProfile(config, profileId);
    return openIndexRuntime(profile, getIndexPaths(profile, config.indexDirectory));
}

export async function openIndexRuntime(profile: RagIndexProfile, paths: IndexPaths): Promise<IndexRuntime> {
    const manifest = await loadIndexManifest(paths.manifestPath);
    validateManifest(manifest, profile, paths);
    const embedder = createEmbedder(profile.embedder);
    validateEmbeddingIdentity(manifest.embedding, embedder.identity);
    const store = createVectorStore(
        manifest.store,
        path.resolve(paths.directory, manifest.dataFile),
        getSearchScoring(profile)
    );

    return {
        profile,
        manifest,
        store,
        embedder,
        findBySource: source => store.findBySource(source),
        search: async (query, topK) => store.search(await embedder.embed(query), topK),
        findRelated: async (source, topK = 8) => {
            const noteChunks = await store.findBySource(source);
            const seedText = relatedSeedText(noteChunks);
            if (!seedText) return [];
            const results = await store.search(await embedder.embed(seedText), topK + noteChunks.length);
            return results.filter(item => normalizeSource(item.source) !== normalizeSource(source)).slice(0, topK);
        }
    };
}

function getSearchScoring(profile: RagIndexProfile): VectorSearchScoring {
    if (profile.embedder.type === 'bm25') {
        return { type: 'bm25', k1: profile.embedder.k1 ?? 1.2, b: profile.embedder.b ?? 0.75 };
    }
    return { type: 'cosine' };
}

export async function writeIndexManifest(profile: RagIndexProfile, paths: IndexPaths, identity: EmbeddingIdentity): Promise<IndexManifest> {
    const manifest: IndexManifest = {
        version: 1,
        profileId: profile.id,
        profileFingerprint: fingerprintProfile(profile),
        embedding: identity,
        store: profile.store,
        dataFile: path.basename(paths.dataPath),
        chunkSize: profile.chunkSize,
        overlap: profile.overlap,
        createdAt: new Date().toISOString()
    };
    await fs.mkdir(paths.directory, { recursive: true });
    const temporaryPath = `${paths.manifestPath}.${process.pid}.tmp`;
    try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
        await fs.rename(temporaryPath, paths.manifestPath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
    return manifest;
}

export async function loadIndexManifest(manifestPath: string): Promise<IndexManifest> {
    let value: unknown;
    try {
        value = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    } catch (error: any) {
        throw new Error(`cannot open RAG index manifest "${manifestPath}": ${error.message}`);
    }
    if (!isRecord(value) || value.version !== 1) throw new Error(`invalid RAG index manifest: ${manifestPath}`);
    return value as unknown as IndexManifest;
}

function validateManifest(manifest: IndexManifest, profile: RagIndexProfile, paths: IndexPaths): void {
    if (manifest.profileId !== profile.id) throw new Error(`RAG index manifest profile mismatch: expected ${profile.id}, got ${manifest.profileId}`);
    if (manifest.profileFingerprint !== fingerprintProfile(profile)) {
        throw new Error(`RAG index profile changed since this index was built: ${profile.id}; rebuild it before querying`);
    }
    if (manifest.store !== profile.store) throw new Error(`RAG index store mismatch for profile ${profile.id}`);
    if (manifest.chunkSize !== profile.chunkSize || manifest.overlap !== profile.overlap) {
        throw new Error(`RAG index chunk configuration changed for profile ${profile.id}; rebuild it before querying`);
    }
    if (path.dirname(path.resolve(paths.directory, manifest.dataFile)) !== paths.directory) {
        throw new Error(`RAG index manifest dataFile must stay inside its profile directory: ${profile.id}`);
    }
}

function validateEmbeddingIdentity(expected: EmbeddingIdentity, actual: EmbeddingIdentity): void {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(`RAG index embedding mismatch: index=${JSON.stringify(expected)}, runtime=${JSON.stringify(actual)}`);
    }
}

function relatedSeedText(chunks: IndexedChunk[]): string {
    return chunks.map(chunk => [
        chunk.titlePath?.join(' '),
        chunk.tags?.join(' '),
        chunk.links?.join(' '),
        chunk.text
    ].filter(Boolean).join('\n')).join('\n').trim();
}

function normalizeSource(source: string): string {
    return source.replace(/\\/g, '/').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
