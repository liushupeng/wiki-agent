import { SourceDocument, TextChunk } from './types.js';

export type Chunker = (source: string, text: string, chunkSize?: number, overlap?: number) => TextChunk[];

const CHUNKERS_BY_EXTENSION: Record<string, Chunker> = {
    '.md': chunkMarkdown,
    '.markdown': chunkMarkdown,
    '.txt': chunkText
};

export function chunkText(source: string, text: string, chunkSize = 900, overlap = 120): TextChunk[] {
    const chunks: TextChunk[] = [];
    const normalized = text.replace(/\r\n/g, '\n');
    let start = 0;

    while (start < normalized.length) {
        const end = Math.min(start + chunkSize, normalized.length);
        const chunk = normalized.slice(start, end).trim();

        if (chunk) {
            chunks.push({
                id: `${source}#${chunks.length + 1}`,
                source,
                text: chunk,
                start,
                end
            });
        }

        if (end === normalized.length) break;
        start = Math.max(0, end - overlap);
    }

    return chunks;
}

type MarkdownSection = {
    titlePath: string[];
    text: string;
    start: number;
    end: number;
};

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const WIKI_LINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

/**
 * 按 Markdown 语义切分文档，并为每个 chunk 补充标题路径、标签、
 * Wiki 链接和 frontmatter。
 *
 * 整体分两层切分：
 * 1. 先按 Markdown 标题切成 section，保留每段所在的标题层级。
 * 2. 再用 chunkText 按字符数切分过长的 section，并添加 overlap。
 */
export function chunkMarkdown(source: string, text: string, chunkSize = 1200, overlap = 160): TextChunk[] {
    // 统一换行符，使后续计算出的字符位置在不同操作系统上保持一致。
    const normalized = text.replace(/\r\n/g, '\n');

    // frontmatter 不参与正文切分，但会作为元数据附加到每个 chunk。
    // bodyOffset 表示正文在完整文档中的起始位置，用于恢复绝对字符位置。
    const { frontmatter, body, bodyOffset } = parseFrontmatter(normalized);

    // 标签属于文档级元数据：同时收集 frontmatter tags 和正文中的 #tag。
    const tags = extractTags(normalized, frontmatter);

    // section 记录标题层级以及它在完整文档中的绝对起止位置。
    const sections = splitMarkdownSections(body, bodyOffset);
    const chunks: TextChunk[] = [];

    for (const section of sections) {
        // chunkText 返回的 start/end 是相对于当前 section.text 的位置。
        const sectionChunks = chunkText(source, section.text, chunkSize, overlap);
        for (const chunk of sectionChunks) {
            // 转换成相对于完整 Markdown 文档的绝对位置，方便后续定位原文。
            const absoluteStart = section.start + chunk.start;
            const absoluteEnd = section.start + chunk.end;

            // 从标准化后的完整原文重新截取，保证保存的文本与绝对位置一致。
            const chunkTextValue = normalized.slice(absoluteStart, absoluteEnd);
            chunks.push({
                ...chunk,
                // chunkText 会从 1 重新编号，因此这里按整个 Markdown 文档统一编号。
                id: `${source}#${chunks.length + 1}`,
                start: absoluteStart,
                end: absoluteEnd,
                text: chunkTextValue.trim(),
                titlePath: section.titlePath,
                tags,
                // 链接是 chunk 级元数据，只记录当前文本片段实际包含的 Wiki 链接。
                links: extractWikiLinks(chunkTextValue),
                frontmatter
            });
        }
    }

    return chunks;
}

/**
 * 返回 RAG 索引默认支持扫描的文本文件扩展名。
 *
 * 新增一种文本文件类型时，把扩展名和对应 chunker 加到
 * CHUNKERS_BY_EXTENSION；documentLoader 会自动使用这里的列表。
 */
export function getSupportedSourceExtensions(): string[] {
    return Object.keys(CHUNKERS_BY_EXTENSION);
}

/**
 * 根据文档类型选择 chunker。
 *
 * 这是文件切分策略的扩展点。后续支持 PDF、HTML、代码文件时，
 * 可以在这里按 extension 分发到新的 chunker，索引 pipeline 不需要改。
 */
export function selectChunker(document: Pick<SourceDocument, 'extension'>): Chunker {
    return CHUNKERS_BY_EXTENSION[normalizeExtension(document.extension)] ?? chunkText;
}

/**
 * 对单个 SourceDocument 执行切分。
 *
 * pipeline 只调用这个函数，从而和具体文件类型的切分细节解耦。
 */
export function chunkDocument(document: SourceDocument, chunkSize?: number, overlap?: number): TextChunk[] {
    return selectChunker(document)(document.source, document.content, chunkSize, overlap);
}

function normalizeExtension(extension: string): string {
    return extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string | string[]>; body: string; bodyOffset: number } {
    if (!text.startsWith('---\n')) {
        return { frontmatter: {}, body: text, bodyOffset: 0 };
    }

    const endIndex = text.indexOf('\n---', 4);
    if (endIndex === -1) {
        return { frontmatter: {}, body: text, bodyOffset: 0 };
    }

    const rawFrontmatter = text.slice(4, endIndex).trim();
    const bodyOffset = endIndex + '\n---'.length + 1;
    const frontmatter: Record<string, string | string[]> = {};

    for (const line of rawFrontmatter.split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;

        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!key) continue;

        if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
            frontmatter[key] = rawValue.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean);
        } else {
            frontmatter[key] = rawValue.replace(/^["']|["']$/g, '');
        }
    }

    return {
        frontmatter,
        body: text.slice(bodyOffset),
        bodyOffset
    };
}

function splitMarkdownSections(body: string, offset: number): MarkdownSection[] {
    const sections: MarkdownSection[] = [];
    const lines = body.split('\n');
    const headingStack: string[] = [];
    let currentLines: string[] = [];
    let currentTitlePath: string[] = [];
    let currentStart = offset;
    let cursor = offset;

    const flush = (end: number) => {
        const text = currentLines.join('\n').trim();
        if (!text) return;
        sections.push({
            titlePath: currentTitlePath,
            text,
            start: currentStart,
            end
        });
    };

    for (const line of lines) {
        const lineWithNewlineLength = line.length + 1;
        const headingMatch = line.match(HEADING_PATTERN);

        if (headingMatch) {
            flush(cursor);
            const level = headingMatch[1].length;
            headingStack.splice(level - 1);
            headingStack[level - 1] = headingMatch[2].trim();
            currentTitlePath = headingStack.filter(Boolean);
            currentLines = [line];
            currentStart = cursor;
        } else {
            currentLines.push(line);
        }

        cursor += lineWithNewlineLength;
    }

    flush(offset + body.length);
    return sections.length > 0 ? sections : [{ titlePath: [], text: body, start: offset, end: offset + body.length }];
}

function extractTags(text: string, frontmatter: Record<string, string | string[]>): string[] {
    const tags = new Set<string>();
    const frontmatterTags = frontmatter.tags;

    if (Array.isArray(frontmatterTags)) {
        frontmatterTags.forEach(tag => tags.add(tag.replace(/^#/, '')));
    } else if (typeof frontmatterTags === 'string') {
        frontmatterTags.split(/[,\s]+/).filter(Boolean).forEach(tag => tags.add(tag.replace(/^#/, '')));
    }

    for (const match of text.matchAll(TAG_PATTERN)) {
        tags.add(match[2]);
    }

    return Array.from(tags);
}

function extractWikiLinks(text: string): string[] {
    return Array.from(text.matchAll(WIKI_LINK_PATTERN), match => match[1].trim());
}
