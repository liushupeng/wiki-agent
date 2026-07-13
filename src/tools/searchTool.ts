import fs from 'fs/promises';
import path from 'path';
import { BaseAgentTool } from './base.js';
import { resolveSafePath, toSandboxRelativePath } from '../sandbox.js';
import { ToolResult } from '../types.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);

async function walkFiles(root: string, maxFiles: number, files: string[] = []): Promise<string[]> {
    if (files.length >= maxFiles) return files;

    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (DEFAULT_IGNORES.has(entry.name)) continue;

        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(fullPath, maxFiles, files);
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DOUBLE_STAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLE_STAR::/g, '.*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${escaped}$`, 'i');
}

export class GlobSearchTool extends BaseAgentTool {
    readonly name = 'glob_search';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'glob_search',
            description: '在安全沙盒内按 glob 模式查找文件，例如 "**/*.ts" 或 "src/**/*.md"',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'glob 文件匹配模式' },
                    relativePath: { type: 'string', description: '搜索起点，默认 "."' },
                    maxResults: { type: 'number', description: '最多返回多少个文件，默认 50' }
                },
                required: ['pattern']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { pattern?: unknown; relativePath?: unknown; maxResults?: unknown };
        const errors: string[] = [];
        if (typeof typed.pattern !== 'string' || !typed.pattern.trim()) errors.push('pattern must be a non-empty string');
        if (typed.relativePath !== undefined && typeof typed.relativePath !== 'string') errors.push('relativePath must be a string');
        if (typed.maxResults !== undefined && (typeof typed.maxResults !== 'number' || typed.maxResults <= 0)) errors.push('maxResults must be a positive number');
        return errors;
    }

    async execute(args: { pattern: string; relativePath?: string; maxResults?: number }): Promise<ToolResult> {
        try {
            const root = resolveSafePath(args.relativePath ?? '.');
            const maxResults = Math.min(args.maxResults ?? 50, 200);
            const matcher = globToRegExp(args.pattern);
            const files = await walkFiles(root, 5000);
            const matches = files
                .map(toSandboxRelativePath)
                .filter(file => matcher.test(file))
                .slice(0, maxResults);

            return this.ok({ matches }, { count: matches.length, maxResults });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

export class GrepSearchTool extends BaseAgentTool {
    readonly name = 'grep_search';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'grep_search',
            description: '在安全沙盒内搜索文本内容，返回文件、行号和匹配行',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '要搜索的字符串或正则表达式' },
                    relativePath: { type: 'string', description: '搜索起点，默认 "."' },
                    regex: { type: 'boolean', description: '是否把 query 当作正则表达式，默认 false' },
                    maxResults: { type: 'number', description: '最多返回多少条匹配，默认 50' }
                },
                required: ['query']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { query?: unknown; relativePath?: unknown; regex?: unknown; maxResults?: unknown };
        const errors: string[] = [];
        if (typeof typed.query !== 'string' || !typed.query.trim()) errors.push('query must be a non-empty string');
        if (typed.relativePath !== undefined && typeof typed.relativePath !== 'string') errors.push('relativePath must be a string');
        if (typed.regex !== undefined && typeof typed.regex !== 'boolean') errors.push('regex must be a boolean');
        if (typed.maxResults !== undefined && (typeof typed.maxResults !== 'number' || typed.maxResults <= 0)) errors.push('maxResults must be a positive number');
        return errors;
    }

    async execute(args: { query: string; relativePath?: string; regex?: boolean; maxResults?: number }): Promise<ToolResult> {
        try {
            const root = resolveSafePath(args.relativePath ?? '.');
            const maxResults = Math.min(args.maxResults ?? 50, 200);
            const matcher = args.regex ? new RegExp(args.query, 'i') : null;
            const files = await walkFiles(root, 5000);
            const matches: Array<{ file: string; line: number; text: string }> = [];

            for (const file of files) {
                if (matches.length >= maxResults) break;

                let content = '';
                try {
                    content = await fs.readFile(file, 'utf-8');
                } catch {
                    continue;
                }

                const lines = content.split(/\r?\n/);
                for (let index = 0; index < lines.length; index++) {
                    const text = lines[index];
                    const matched = matcher ? matcher.test(text) : text.toLowerCase().includes(args.query.toLowerCase());
                    if (!matched) continue;

                    matches.push({
                        file: toSandboxRelativePath(file),
                        line: index + 1,
                        text: text.trim()
                    });
                    if (matches.length >= maxResults) break;
                }
            }

            return this.ok({ matches }, { count: matches.length, maxResults });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}
