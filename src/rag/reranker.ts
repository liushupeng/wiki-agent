import { RerankerProfile } from './retrievalProfiles.js';

export interface Reranker {
    readonly name: string;
    score(query: string, documents: string[]): Promise<number[]>;
}

type LoadedReranker = {
    tokenizer: any;
    model: any;
};

const modelCache = new Map<string, Promise<LoadedReranker>>();

export class TransformersJsReranker implements Reranker {
    readonly name: string;

    constructor(private readonly profile: RerankerProfile) {
        this.name = `transformers-js:${profile.model}`;
    }

    async score(query: string, documents: string[]): Promise<number[]> {
        if (documents.length === 0) return [];
        const { tokenizer, model } = await this.load();
        const scores: number[] = [];
        for (let offset = 0; offset < documents.length; offset += this.profile.batchSize) {
            const batch = documents.slice(offset, offset + this.profile.batchSize);
            const inputs = await tokenizer(
                batch.map(() => query),
                {
                    text_pair: batch,
                    padding: true,
                    truncation: true,
                    max_length: this.profile.maxLength
                }
            );
            const output = await model(inputs);
            const logits = output.logits;
            const values: unknown = typeof logits?.tolist === 'function' ? logits.tolist() : logits?.data;
            const batchScores = flattenSingleLogits(values);
            if (batchScores.length !== batch.length) {
                throw new Error(`reranker returned ${batchScores.length} scores for ${batch.length} documents`);
            }
            if (batchScores.some(value => !Number.isFinite(value))) {
                throw new Error('reranker output contains NaN or Infinity');
            }
            scores.push(...batchScores);
        }
        return scores;
    }

    private async load(): Promise<LoadedReranker> {
        const key = JSON.stringify(this.profile);
        let loading = modelCache.get(key);
        if (!loading) {
            loading = (async () => {
                const transformers = await import('@huggingface/transformers');
                if (this.profile.cacheDir) transformers.env.cacheDir = this.profile.cacheDir;
                const common = {
                    ...(this.profile.revision ? { revision: this.profile.revision } : {}),
                    ...(this.profile.cacheDir ? { cache_dir: this.profile.cacheDir } : {})
                };
                const tokenizer = await transformers.AutoTokenizer.from_pretrained(this.profile.model, common);
                const model = await transformers.AutoModelForSequenceClassification.from_pretrained(this.profile.model, {
                    ...common,
                    ...(this.profile.dtype ? { dtype: this.profile.dtype as any } : {}),
                    ...(this.profile.device ? { device: this.profile.device as any } : {})
                });
                return { tokenizer, model };
            })();
            modelCache.set(key, loading);
        }
        try {
            return await loading;
        } catch (error) {
            modelCache.delete(key);
            throw error;
        }
    }
}

function flattenSingleLogits(value: unknown): number[] {
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (Array.isArray(item)) {
            if (item.length !== 1) throw new Error(`reranker expected one logit per pair, received ${item.length}`);
            return Number(item[0]);
        }
        return Number(item);
    });
}
