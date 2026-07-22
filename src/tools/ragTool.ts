import path from 'path';
import { BaseAgentTool } from './base.js';
import { grepNotes } from '../rag/grep.js';
import { prioritizeWikiMatches } from '../rag/ranking.js';
import { IndexedChunk, SearchResult } from '../rag/types.js';
import { getKnowledgeSourceRoots, sourceWithPrefix } from '../rag/sourceRoots.js';
import { createVectorStoreFromEnv } from '../rag/vectorStore.js';
import { getActiveSpan } from '../trace/telemetry.js';
import { ToolResult } from '../types.js';

const DEFAULT_GREP_MAX_RESULTS = 10;
const GREP_MAX_RESULTS_LIMIT = 30;
const DEFAULT_GREP_CONTEXT_LINES = 1;
const GREP_CONTEXT_LINES_LIMIT = 2;
const DEFAULT_READ_NOTE_MAX_CHUNKS = 8;
const READ_NOTE_MAX_CHUNKS_LIMIT = 30;
const DEFAULT_RELATED_NOTES_TOP_K = 5;
const RELATED_NOTES_TOP_K_LIMIT = 12;
const RELATED_NOTES_CANDIDATE_LIMIT = 80;
const REGEX_HINT_PATTERN = /(^|[^\\])(\||\.\*|\.\+|\[[^\]]+\]|\([^)]*\|[^)]*\)|\\d|\\w|\\s|\{\d+(?:,\d*)?\})/;

function getIndexPath(): string {
    return path.resolve(process.env.KNOWLEDGE_INDEX_PATH ?? 'var/knowledge/index.json');
}

function getVectorStore() {
    return createVectorStoreFromEnv({ filePath: getIndexPath() });
}

async function getSearchScopeDescription(): Promise<string> {
    return (await getKnowledgeSourceRoots()).map(sourceRoot => `${sourceRoot.prefix}=${sourceRoot.root}`).join(', ');
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

function formatIndexedChunk(chunk: IndexedChunk) {
    return {
        source: chunk.source,
        chunkId: chunk.id,
        titlePath: chunk.titlePath ?? [],
        tags: chunk.tags ?? [],
        links: chunk.links ?? [],
        span: { start: chunk.start, end: chunk.end },
        text: chunk.text
    };
}

function shouldAutoUseRegex(query: string): boolean {
    return REGEX_HINT_PATTERN.test(query);
}

function normalizeText(value: string): string {
    return value.toLowerCase();
}

function splitQueryTerms(query: string): string[] {
    return query
        .toLowerCase()
        .split(/[\s,，、;；]+/)
        .map(term => term.trim())
        .filter(Boolean);
}

function chunkSearchText(chunk: IndexedChunk): string {
    return [
        chunk.titlePath?.join(' '),
        chunk.tags?.join(' '),
        chunk.links?.join(' '),
        chunk.text
    ].filter(Boolean).join('\n').toLowerCase();
}

function titlePathMatches(chunk: IndexedChunk, titlePathQuery?: string): boolean {
    if (!titlePathQuery?.trim()) return true;
    return normalizeText((chunk.titlePath ?? []).join(' > ')).includes(normalizeText(titlePathQuery.trim()));
}

function rankNoteChunks(chunks: IndexedChunk[], query?: string): IndexedChunk[] {
    if (!query?.trim()) return chunks;
    const terms = splitQueryTerms(query);
    if (terms.length === 0) return chunks;

    return chunks
        .map((chunk, index) => {
            const text = chunkSearchText(chunk);
            const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
            return { chunk, index, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.chunk);
}

function normalizeSource(source: string): string {
    return source.replace(/\\/g, '/');
}

function getSourceRoot(source: string): string {
    return normalizeSource(source).split('/')[0] ?? '';
}

function getSourceDirectory(source: string): string {
    const normalized = normalizeSource(source);
    const directory = path.posix.dirname(normalized);
    return directory === '.' ? '' : directory;
}

function matchesRelatedScope(candidate: SearchResult, notePath: string, scope: RelatedNotesScope): boolean {
    if (scope === 'global') return true;

    const normalizedCandidate = normalizeSource(candidate.source);
    const normalizedNotePath = normalizeSource(notePath);
    if (scope === 'sourceRoot') {
        return getSourceRoot(normalizedCandidate) === getSourceRoot(normalizedNotePath);
    }

    return getSourceDirectory(normalizedCandidate) === getSourceDirectory(normalizedNotePath);
}

type RelatedNotesScope = 'sameDirectory' | 'sourceRoot' | 'global';

function isRelatedNotesScope(value: unknown): value is RelatedNotesScope {
    return value === 'sameDirectory' || value === 'sourceRoot' || value === 'global';
}

export class SearchNotesTool extends BaseAgentTool {
    readonly name = 'search_notes';
    readonly permission = 'rag' as const;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'search_notes',
            description: '检索本地知识索引，优先返回 agent-maintained wiki 命中；适合概念、经验、项目知识和历史决策类问题',
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

    async execute(args: { query: string; topK?: number }): Promise<ToolResult> {
        const topK = Math.min(args.topK ?? 5, 12);
        const ragSpan = await getActiveSpan()?.startChild('rag.search', {
            attributes: {
                'wiki_agent.rag.query': args.query,
                'wiki_agent.rag.top_k': topK,
                'wiki_agent.rag.mode': 'vector'
            }
        });
        try {
            const indexPath = getIndexPath();
            const candidateLimit = Math.min(topK * 4, 48);
            const matches = prioritizeWikiMatches(await getVectorStore().search(args.query, candidateLimit), topK);
            await ragSpan?.end({
                status: 'ok',
                attributes: { 'wiki_agent.rag.match_count': matches.length }
            });

            return this.ok({
                query: args.query,
                matches: matches.map(formatChunk)
            }, { count: matches.length, indexPath, scope: await getSearchScopeDescription() });
        } catch (error: any) {
            await ragSpan?.end({ status: 'error', attributes: { 'error.message': error.message } });
            return this.error(error.message, {
                hint: '请先运行 npm run index:notes 生成 var/knowledge/index.json。'
            });
        }
    }
}

export class GrepNotesTool extends BaseAgentTool {
    readonly name = 'grep_notes';
    readonly permission = 'rag' as const;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'grep_notes',
            description: '在本地 Markdown/text 知识库中做关键词或正则 grep 检索；优先搜索 configured knowledge roots，适合查找精确术语、配置名、函数名和文件名',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '要搜索的关键词或正则表达式；包含 |、.*、\\d 等正则特征时会自动按 regex 搜索' },
                    regex: { type: 'boolean', description: '是否把 query 当作正则表达式；不传时会根据 query 自动判断' },
                    maxResults: { type: 'number', description: '最多返回多少条匹配，默认 10，常规问题先不要超过 10；需要展开证据时再提高，最多 30' },
                    contextLines: { type: 'number', description: '每条匹配前后返回多少行上下文，默认 1，最多 2；只需要确认命中时可设为 0' }
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

    async execute(args: { query: string; regex?: boolean; maxResults?: number; contextLines?: number }): Promise<ToolResult> {
        const maxResults = Math.min(args.maxResults ?? DEFAULT_GREP_MAX_RESULTS, GREP_MAX_RESULTS_LIMIT);
        const ragSpan = await getActiveSpan()?.startChild('rag.search', {
            attributes: {
                'wiki_agent.rag.query': args.query,
                'wiki_agent.rag.top_k': maxResults,
                'wiki_agent.rag.mode': 'grep'
            }
        });
        try {
            const contextLines = Math.min(args.contextLines ?? DEFAULT_GREP_CONTEXT_LINES, GREP_CONTEXT_LINES_LIMIT);
            const effectiveRegex = args.regex ?? shouldAutoUseRegex(args.query);
            const sourceRoots = await getKnowledgeSourceRoots();
            const matches = (await Promise.all(sourceRoots.map(async sourceRoot => {
                const matchesForRoot = await grepNotes(path.resolve(sourceRoot.root), args.query, {
                    regex: effectiveRegex,
                    maxResults,
                    contextLines,
                    ignorePatterns: sourceRoot.ignore
                });

                return matchesForRoot.map(match => ({
                    ...match,
                    source: sourceWithPrefix(sourceRoot.prefix, match.source)
                }));
            }))).flat().slice(0, maxResults);

            await ragSpan?.end({
                status: 'ok',
                attributes: { 'wiki_agent.rag.match_count': matches.length }
            });

            return this.ok({
                query: args.query,
                regex: effectiveRegex,
                matches
            }, { count: matches.length, scope: await getSearchScopeDescription(), maxResults, contextLines, autoRegex: args.regex === undefined && effectiveRegex });
        } catch (error: any) {
            await ragSpan?.end({ status: 'error', attributes: { 'error.message': error.message } });
            return this.error(error.message, {
                hint: '请确认 KNOWLEDGE_SOURCES_CONFIG_PATH 指向有效的 knowledge sources JSONC 配置。'
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
            description: '按笔记相对路径局部读取索引中的 Markdown 笔记片段；默认只返回少量 chunks，适合用 query 或 titlePath 精准查看大文件的相关章节',
            parameters: {
                type: 'object',
                properties: {
                    notePath: { type: 'string', description: '笔记在索引根目录下的相对路径，例如 raw/area/agent.md' },
                    query: { type: 'string', description: '可选：只返回包含相关关键词的 chunks，适合从大文件中局部读取证据' },
                    titlePath: { type: 'string', description: '可选：按 Markdown 标题路径筛选，例如 15 投资体系' },
                    maxChunks: { type: 'number', description: '最多返回多少个 chunks，默认 8，最多 30；不要用它读取整篇大文件' }
                },
                required: ['notePath']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { notePath?: unknown; query?: unknown; titlePath?: unknown; maxChunks?: unknown };
        const errors: string[] = [];
        if (typeof typed.notePath !== 'string' || !typed.notePath.trim()) errors.push('notePath must be a non-empty string');
        if (typed.query !== undefined && typeof typed.query !== 'string') errors.push('query must be a string');
        if (typed.titlePath !== undefined && typeof typed.titlePath !== 'string') errors.push('titlePath must be a string');
        if (typed.maxChunks !== undefined && (typeof typed.maxChunks !== 'number' || typed.maxChunks <= 0)) errors.push('maxChunks must be a positive number');
        return errors;
    }

    async execute(args: { notePath: string; query?: string; titlePath?: string; maxChunks?: number }): Promise<ToolResult> {
        const ragSpan = await getActiveSpan()?.startChild('rag.read_note', {
            attributes: {
                'wiki_agent.rag.note_path': args.notePath,
                'wiki_agent.rag.query': args.query ?? '',
                'wiki_agent.rag.title_path': args.titlePath ?? ''
            }
        });
        try {
            const maxChunks = Math.min(args.maxChunks ?? DEFAULT_READ_NOTE_MAX_CHUNKS, READ_NOTE_MAX_CHUNKS_LIMIT);
            const allChunks = await getVectorStore().findBySource(args.notePath);
            const titleFilteredChunks = allChunks.filter(chunk => titlePathMatches(chunk, args.titlePath));
            const rankedChunks = rankNoteChunks(titleFilteredChunks, args.query);
            const chunks = rankedChunks.slice(0, maxChunks);
            await ragSpan?.end({
                status: 'ok',
                attributes: {
                    'wiki_agent.rag.match_count': chunks.length,
                    'wiki_agent.rag.total_chunks': allChunks.length,
                    'wiki_agent.rag.returned_chunks': chunks.length
                }
            });

            return this.ok({
                notePath: args.notePath,
                query: args.query,
                titlePath: args.titlePath,
                chunks: chunks.map(formatIndexedChunk)
            }, { count: chunks.length, totalChunks: allChunks.length, maxChunks, truncated: chunks.length < titleFilteredChunks.length });
        } catch (error: any) {
            await ragSpan?.end({ status: 'error', attributes: { 'error.message': error.message } });
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
            description: '根据某篇 Markdown 笔记查找相关笔记；默认只在同目录内找，避免大知识库中跨领域跑偏',
            parameters: {
                type: 'object',
                properties: {
                    notePath: { type: 'string', description: '笔记在索引根目录下的相对路径' },
                    topK: { type: 'number', description: '返回相关片段数量，默认 5，最多 12' },
                    scope: {
                        type: 'string',
                        enum: ['sameDirectory', 'sourceRoot', 'global'],
                        description: '相关笔记检索范围，默认 sameDirectory；需要跨目录时用 sourceRoot，只有明确需要全库扩展时才用 global'
                    }
                },
                required: ['notePath']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { notePath?: unknown; topK?: unknown; scope?: unknown };
        const errors: string[] = [];
        if (typeof typed.notePath !== 'string' || !typed.notePath.trim()) errors.push('notePath must be a non-empty string');
        if (typed.topK !== undefined && (typeof typed.topK !== 'number' || typed.topK <= 0)) errors.push('topK must be a positive number');
        if (typed.scope !== undefined && !isRelatedNotesScope(typed.scope)) errors.push('scope must be one of sameDirectory, sourceRoot, global');
        return errors;
    }

    async execute(args: { notePath: string; topK?: number; scope?: RelatedNotesScope }): Promise<ToolResult> {
        const topK = Math.min(args.topK ?? DEFAULT_RELATED_NOTES_TOP_K, RELATED_NOTES_TOP_K_LIMIT);
        const scope = args.scope ?? 'sameDirectory';
        const ragSpan = await getActiveSpan()?.startChild('rag.related_notes', {
            attributes: {
                'wiki_agent.rag.note_path': args.notePath,
                'wiki_agent.rag.top_k': topK,
                'wiki_agent.rag.scope': scope
            }
        });
        try {
            const candidateLimit = scope === 'global' ? topK : Math.min(topK * 10, RELATED_NOTES_CANDIDATE_LIMIT);
            const candidates = await getVectorStore().findRelated(args.notePath, candidateLimit);
            const matches = candidates
                .filter(candidate => matchesRelatedScope(candidate, args.notePath, scope))
                .slice(0, topK);
            await ragSpan?.end({
                status: 'ok',
                attributes: {
                    'wiki_agent.rag.match_count': matches.length,
                    'wiki_agent.rag.candidate_count': candidates.length
                }
            });

            return this.ok({
                notePath: args.notePath,
                scope,
                matches: matches.map(formatChunk)
            }, { count: matches.length, scope, candidateCount: candidates.length });
        } catch (error: any) {
            await ragSpan?.end({ status: 'error', attributes: { 'error.message': error.message } });
            return this.error(error.message);
        }
    }
}
