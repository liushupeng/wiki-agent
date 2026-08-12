import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Embedder } from './embeddings.js';
import { Vector } from './types.js';

export class CachedEmbedder implements Embedder {
    readonly name: string;
    readonly identity;

    constructor(
        private readonly inner: Embedder,
        private readonly cacheDirectory: string
    ) {
        this.name = `cached:${inner.name}`;
        this.identity = inner.identity;
    }

    async embed(text: string): Promise<Vector> {
        return (await this.embedBatch([text]))[0]!;
    }

    async embedBatch(texts: string[]): Promise<Vector[]> {
        const results: Array<Vector | undefined> = new Array(texts.length);
        const misses: Array<{ index: number; text: string; file: string }> = [];
        await Promise.all(texts.map(async (text, index) => {
            const file = this.cachePath(text);
            const cached = await readDenseVector(file, this.identity.dimensions);
            if (cached) results[index] = cached;
            else misses.push({ index, text, file });
        }));
        if (misses.length > 0) {
            const generated = this.inner.embedBatch
                ? await this.inner.embedBatch(misses.map(item => item.text))
                : await Promise.all(misses.map(item => this.inner.embed(item.text)));
            if (generated.length !== misses.length) {
                throw new Error(`embedding cache received ${generated.length} vectors for ${misses.length} misses`);
            }
            await Promise.all(misses.map(async (miss, index) => {
                const vector = generated[index]!;
                results[miss.index] = vector;
                if (Array.isArray(vector)) await writeDenseVector(miss.file, vector);
            }));
        }
        return results as Vector[];
    }

    private cachePath(text: string): string {
        const hash = createHash('sha256')
            .update(JSON.stringify(this.identity))
            .update('\0')
            .update(text)
            .digest('hex');
        return path.resolve(this.cacheDirectory, hash.slice(0, 2), `${hash}.f32`);
    }
}

async function readDenseVector(file: string, dimensions?: number): Promise<number[] | undefined> {
    try {
        const data = await fs.readFile(file);
        if (data.byteLength % 4 !== 0) return undefined;
        const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
        if (dimensions !== undefined && values.length !== dimensions) return undefined;
        return Array.from(values);
    } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
}

async function writeDenseVector(file: string, vector: number[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    const values = Float32Array.from(vector);
    try {
        await fs.writeFile(temporary, Buffer.from(values.buffer, values.byteOffset, values.byteLength), { flag: 'wx' });
        await fs.rename(temporary, file);
    } catch (error: any) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if (error?.code !== 'EEXIST') throw error;
    }
}
