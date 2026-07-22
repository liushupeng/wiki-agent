export type SourceDocument = {
    // 文档在知识源根目录下的稳定相对路径，作为 citation/source 使用。
    source: string;
    // 真实文件路径，只在加载和调试阶段使用，不暴露给模型。
    absolutePath: string;
    // 小写扩展名，用于选择 chunker，例如 .md / .txt。
    extension: string;
    content: string;
};

export type TextChunk = {
    id: string;
    source: string;
    text: string;
    start: number;
    end: number;
    titlePath?: string[];
    tags?: string[];
    links?: string[];
    frontmatter?: Record<string, string | string[]>;
};

export type SparseVector = Record<string, number>;
export type DenseVector = number[];
export type Vector = SparseVector | DenseVector;

export type IndexedChunk = TextChunk & {
    // 由 Embedder 生成的向量；当前 tf embedder 使用稀疏词频向量。
    vector: Vector;
};

export type SearchResult = IndexedChunk & {
    score: number;
};

export type KnowledgeIndex = {
    version: 2;
    createdAt: string;
    // 记录索引时的切分参数，便于对比不同实验结果。
    chunkSize: number;
    overlap: number;
    chunks: IndexedChunk[];
};
