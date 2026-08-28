import { openRetriever, type RetrievalIndexIdentity, type RetrievalRun, type Retriever } from './retrievalPipeline.js';
import type { RetrievalProfile } from './retrievalProfiles.js';

export type RetrievalRuntimeRequest = {
    retrievalProfile?: string;
    variant?: string;
    query: string;
    topK?: number;
    candidateLimit?: number;
};

export type RetrievalRuntimeMetrics = {
    retrieverCacheHit: boolean;
    retrieverOpenMs: number;
    queueWaitMs: number;
};

export type RetrievalRuntimeResult = {
    run: RetrievalRun;
    profile: RetrievalProfile;
    identity?: RetrievalIndexIdentity;
    metrics: RetrievalRuntimeMetrics;
};

export interface RetrievalRuntime {
    retrieve(request: RetrievalRuntimeRequest): Promise<RetrievalRuntimeResult>;
}

type RetrieverOpener = (retrievalProfile?: string, variant?: string) => Promise<Retriever>;

/**
 * 复用同一 profile/variant 的索引和模型实例，并限制 CPU 密集检索的并发度。
 *
 * Agent 的只读工具仍可并行调度；只有进入完整检索管线时才通过此处排队，
 * 避免多个 BGE/Reranker 任务同时争抢本机 CPU。
 */
export class CachedRetrievalRuntime implements RetrievalRuntime {
    private readonly retrievers = new Map<string, Promise<{ retriever: Retriever; openMs: number }>>();
    private readonly gate: AsyncGate;

    constructor(
        private readonly open: RetrieverOpener = openRetriever,
        maxConcurrency = readMaxConcurrency()
    ) {
        this.gate = new AsyncGate(maxConcurrency);
    }

    async retrieve(request: RetrievalRuntimeRequest): Promise<RetrievalRuntimeResult> {
        const key = `${request.retrievalProfile ?? '<active>'}/${request.variant ?? '<active>'}`;
        const cached = this.retrievers.get(key);
        const retrieverPromise = cached ?? this.openAndMeasure(key, request);
        const { retriever, openMs } = await retrieverPromise;
        const { value: run, queueWaitMs } = await this.gate.run(() => retriever.retrieve(request.query, {
            ...(request.topK === undefined ? {} : { topK: request.topK }),
            ...(request.candidateLimit === undefined ? {} : { candidateLimit: request.candidateLimit })
        }));
        return {
            run,
            profile: retriever.profile,
            ...(retriever.identity ? { identity: retriever.identity } : {}),
            metrics: {
                retrieverCacheHit: cached !== undefined,
                retrieverOpenMs: cached === undefined ? openMs : 0,
                queueWaitMs
            }
        };
    }

    private openAndMeasure(
        key: string,
        request: Pick<RetrievalRuntimeRequest, 'retrievalProfile' | 'variant'>
    ): Promise<{ retriever: Retriever; openMs: number }> {
        const startedAt = performance.now();
        const opening = this.open(request.retrievalProfile, request.variant)
            .then(retriever => ({ retriever, openMs: performance.now() - startedAt }))
            .catch(error => {
                this.retrievers.delete(key);
                throw error;
            });
        this.retrievers.set(key, opening);
        return opening;
    }
}

class AsyncGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly maxConcurrency: number) {
        if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
            throw new Error('retrieval max concurrency must be a positive integer');
        }
    }

    async run<T>(operation: () => Promise<T>): Promise<{ value: T; queueWaitMs: number }> {
        const queuedAt = performance.now();
        await this.acquire();
        const queueWaitMs = performance.now() - queuedAt;
        try {
            return { value: await operation(), queueWaitMs };
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        if (this.active < this.maxConcurrency) {
            this.active += 1;
            return;
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        this.active += 1;
    }

    private release(): void {
        this.active -= 1;
        this.waiters.shift()?.();
    }
}

function readMaxConcurrency(): number {
    const raw = process.env.RAG_RETRIEVAL_MAX_CONCURRENCY?.trim();
    if (!raw) return 1;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('RAG_RETRIEVAL_MAX_CONCURRENCY must be a positive integer');
    }
    return parsed;
}

let defaultRuntime: RetrievalRuntime | undefined;

export function getDefaultRetrievalRuntime(): RetrievalRuntime {
    defaultRuntime ??= new CachedRetrievalRuntime();
    return defaultRuntime;
}
