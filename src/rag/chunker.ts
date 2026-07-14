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

export function chunkMarkdown(source: string, text: string, chunkSize = 1200, overlap = 160): TextChunk[] {
    const normalized = text.replace(/\r\n/g, '\n');
    const { frontmatter, body, bodyOffset } = parseFrontmatter(normalized);
    const tags = extractTags(normalized, frontmatter);
    const sections = splitMarkdownSections(body, bodyOffset);
    const chunks: TextChunk[] = [];

    for (const section of sections) {
        const sectionChunks = chunkText(source, section.text, chunkSize, overlap);
        for (const chunk of sectionChunks) {
            const absoluteStart = section.start + chunk.start;
            const absoluteEnd = section.start + chunk.end;
            const chunkTextValue = normalized.slice(absoluteStart, absoluteEnd);
            chunks.push({
                ...chunk,
                id: `${source}#${chunks.length + 1}`,
                start: absoluteStart,
                end: absoluteEnd,
                text: chunkTextValue.trim(),
                titlePath: section.titlePath,
                tags,
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
