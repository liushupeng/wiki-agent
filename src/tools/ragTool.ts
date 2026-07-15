import path from 'path';
import { BaseAgentTool } from './base.js';
import { grepNotes } from '../rag/grep.js';
import { SearchResult } from '../rag/types.js';
import { createVectorStoreFromEnv } from '../rag/vectorStore.js';
import { TraceLogger } from '../trace.js';
import { ToolResult } from '../types.js';

function getIndexPath(): string {
    return path.resolve(process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
}

function getVectorStore() {
    return createVectorStoreFromEnv({ filePath: getIndexPath() });
}

function getNotesRoot(): string {
    return path.resolve(process.env.NOTES_ROOT ?? 'notes');
}

function formatChunk(match: SearchResult) {
    return {
        source: match.source,
        chunkId: match.id,
        titlePath: match.titlePath ?? [],
        tags: match.tags ?? [],
        links: match.links ?? [],
        score: Number(match.score.toFixed(4)),
        citation: [match.source, ...(match.titlePath ?? [])].join(' > ') || `${match.source}:${match.start}-${match.end}`,
        span: { start: match.start, end: match.end },
        text: match.text
    };
}

export class SearchNotesTool extends BaseAgentTool {
    readonly name = 'search_notes';
    readonly permission = 'rag' as const;
    private traceLogger?: TraceLogger;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'search_notes',
            description: '检索本地 Markdown 笔记索引，返回相关片段、标题路径、tags、wiki links 和引用',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索问题、关键词或概念' },
                    topK: { type: 'number', description: '返回片段数量，默认 5' }
                },
                required: ['query']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { query?: unknown; topK?: unknown };
        const errors: string[] = [];
        if (typeof typed.query !== 'string' || !typed.query.trim()) errors.push('query must be a non-empty string');
        if (typed.topK !== undefined && (typeof typed.topK !== 'number' || typed.topK <= 0)) errors.push('topK must be a positive number');
        return errors;
    }

    setTraceLogger(traceLogger: TraceLogger): void {
        this.traceLogger = traceLogger;
    }

    async execute(args: { query: string; topK?: number }): Promise<ToolResult> {
        try {
            const indexPath = getIndexPath();
            const topK = Math.min(args.topK ?? 5, 12);
            const matches = await getVectorStore().search(args.query, topK);
            await this.traceLogger?.write({
                type: 'rag_search',
                level: 'debug',
                toolName: this.name,
                query: args.query,
                indexPath,
                topK,
                matchCount: matches.length,
                topMatches: matches.slice(0, 5).map(match => ({
                    source: match.source,
                    score: Number(match.score.toFixed(4))
                })),
                at: new Date().toISOString()
            });

            return this.ok({
                query: args.query,
                matches: matches.map(formatChunk)
            }, { count: matches.length, indexPath });
        } catch (error: any) {
            return this.error(error.message, {
                hint: '请先运行 npm run index:notes -- <Markdown 笔记目录> 生成 var/knowledge/index.json。'
            });
        }
    }
}

export class GrepNotesTool extends BaseAgentTool {
    readonly name = 'grep_notes';
    readonly permission = 'rag' as const;
    private traceLogger?: TraceLogger;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'grep_notes',
            description: '在本地 Markdown/text 知识库中做关键词或正则 grep 检索，适合查找精确术语、配置名、函数名和文件名',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '要搜索的关键词或正则表达式' },
                    regex: { type: 'boolean', description: '是否把 query 当作正则表达式，默认 false' },
                    maxResults: { type: 'number', description: '最多返回多少条匹配，默认 50' },
                    contextLines: { type: 'number', description: '每条匹配前后返回多少行上下文，默认 1，最多 5' }
                },
                required: ['query']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { query?: unknown; regex?: unknown; maxResults?: unknown; contextLines?: unknown };
        const errors: string[] = [];
        if (typeof typed.query !== 'string' || !typed.query.trim()) errors.push('query must be a non-empty string');
        if (typed.regex !== undefined && typeof typed.regex !== 'boolean') errors.push('regex must be a boolean');
        if (typed.maxResults !== undefined && (typeof typed.maxResults !== 'number' || typed.maxResults <= 0)) errors.push('maxResults must be a positive number');
        if (typed.contextLines !== undefined && (typeof typed.contextLines !== 'number' || typed.contextLines < 0)) errors.push('contextLines must be a non-negative number');
        return errors;
    }

    setTraceLogger(traceLogger: TraceLogger): void {
        this.traceLogger = traceLogger;
    }

    async execute(args: { query: string; regex?: boolean; maxResults?: number; contextLines?: number }): Promise<ToolResult> {
        try {
            const notesRoot = getNotesRoot();
            const maxResults = Math.min(args.maxResults ?? 50, 200);
            const contextLines = Math.min(args.contextLines ?? 1, 5);
            const matches = await grepNotes(notesRoot, args.query, {
                regex: args.regex,
                maxResults,
                contextLines
            });

            await this.traceLogger?.write({
                type: 'rag_search',
                level: 'debug',
                toolName: this.name,
                query: args.query,
                indexPath: notesRoot,
                topK: maxResults,
                matchCount: matches.length,
                topMatches: matches.slice(0, 5).map(match => ({
                    source: `${match.source}:${match.line}`,
                    score: 1
                })),
                at: new Date().toISOString()
            });

            return this.ok({
                query: args.query,
                regex: args.regex ?? false,
                matches
            }, { count: matches.length, notesRoot, maxResults, contextLines });
        } catch (error: any) {
            return this.error(error.message, {
                hint: '请确认 NOTES_ROOT 指向本地 Markdown/text 知识库目录。'
            });
        }
    }
}

export class ReadNoteTool extends BaseAgentTool {
    readonly name = 'read_note';
    readonly permission = 'rag' as const;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'read_note',
            description: '按笔记相对路径读取索引中的 Markdown 笔记片段，适合查看某篇笔记的结构化内容',
            parameters: {
                type: 'object',
                properties: {
                    notePath: { type: 'string', description: '笔记在索引根目录下的相对路径，例如 area/agent.md' }
                },
                required: ['notePath']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const notePath = (args as { notePath?: unknown }).notePath;
        return typeof notePath === 'string' && notePath.trim() ? [] : ['notePath must be a non-empty string'];
    }

    async execute(args: { notePath: string }): Promise<ToolResult> {
        try {
            const chunks = await getVectorStore().findBySource(args.notePath);

            return this.ok({
                notePath: args.notePath,
                chunks: chunks.map(chunk => ({
                    source: chunk.source,
                    chunkId: chunk.id,
                    titlePath: chunk.titlePath ?? [],
                    tags: chunk.tags ?? [],
                    links: chunk.links ?? [],
                    span: { start: chunk.start, end: chunk.end },
                    text: chunk.text
                }))
            }, { count: chunks.length });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

export class RelatedNotesTool extends BaseAgentTool {
    readonly name = 'related_notes';
    readonly permission = 'rag' as const;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'related_notes',
            description: '根据某篇 Markdown 笔记的正文、标题、tags 和 wiki links 查找相关笔记',
            parameters: {
                type: 'object',
                properties: {
                    notePath: { type: 'string', description: '笔记在索引根目录下的相对路径' },
                    topK: { type: 'number', description: '返回相关片段数量，默认 8' }
                },
                required: ['notePath']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { notePath?: unknown; topK?: unknown };
        const errors: string[] = [];
        if (typeof typed.notePath !== 'string' || !typed.notePath.trim()) errors.push('notePath must be a non-empty string');
        if (typed.topK !== undefined && (typeof typed.topK !== 'number' || typed.topK <= 0)) errors.push('topK must be a positive number');
        return errors;
    }

    async execute(args: { notePath: string; topK?: number }): Promise<ToolResult> {
        try {
            const matches = await getVectorStore().findRelated(args.notePath, Math.min(args.topK ?? 8, 16));

            return this.ok({
                notePath: args.notePath,
                matches: matches.map(formatChunk)
            }, { count: matches.length });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}
