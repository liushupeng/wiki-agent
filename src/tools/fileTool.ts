import path from 'path';
import fs from 'fs/promises';
import { BaseAgentTool } from './base.js';
import { resolveSafePath } from '../sandbox.js';
import { getMaxFileBytes, limitText } from '../limits.js';
import { ToolResult } from '../types.js';

// ==========================================
// 🛠️ 工具 1：list_dir (扫描目录)
// ==========================================
export class ListDirTool extends BaseAgentTool {
    readonly name = 'list_dir';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'list_dir',
            description: '扫描安全沙盒内指定目录下的所有文件和文件夹名称',
            parameters: {
                type: 'object',
                properties: {
                    relativePath: { type: 'string', description: '相对于沙盒根目录的路径，默认传入 "." 代表根目录' }
                },
                required: ['relativePath']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const value = (args as { relativePath?: unknown }).relativePath;
        return value === undefined || typeof value === 'string' ? [] : ['relativePath must be a string'];
    }

    async execute(args: { relativePath: string }): Promise<ToolResult> {
        try {
            const safePath = resolveSafePath(args.relativePath || '.');
            const files = await fs.readdir(safePath, { withFileTypes: true });

            const result = files.map(f => ({
                name: f.name,
                type: f.isDirectory() ? 'directory' : 'file'
            }));

            return this.ok(result, { count: result.length });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

// ==========================================
// 🛠️ 工具 2: read_file (读取文件)
// ==========================================
export class ReadFileTool extends BaseAgentTool {
    readonly name = 'read_file';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'read_file',
            description: '读取安全沙盒内指定文本文件的真实内容（如源码、配置文件等）',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: '相对于沙盒的文件路径，例如: src/main.py' },
                    maxBytes: { type: 'number', description: '最多读取多少字节，默认使用 READ_FILE_MAX_BYTES' }
                },
                required: ['filename']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { filename?: unknown; maxBytes?: unknown };
        const errors: string[] = [];
        if (typeof typed.filename !== 'string' || !typed.filename.trim()) errors.push('filename must be a non-empty string');
        if (typed.maxBytes !== undefined && (typeof typed.maxBytes !== 'number' || typed.maxBytes <= 0)) errors.push('maxBytes must be a positive number');
        return errors;
    }

    async execute(args: { filename: string; maxBytes?: number }): Promise<ToolResult> {
        try {
            const safePath = resolveSafePath(args.filename);
            const maxBytes = Math.min(args.maxBytes ?? getMaxFileBytes(), getMaxFileBytes());
            const stat = await fs.stat(safePath);
            const handle = await fs.open(safePath, 'r');
            try {
                const bytesToRead = Math.min(stat.size, maxBytes);
                const buffer = Buffer.alloc(bytesToRead);
                await handle.read(buffer, 0, bytesToRead, 0);
                const limited = limitText(buffer.toString('utf-8'));
                const truncated = stat.size > maxBytes || limited.truncated;
                return this.ok(
                    { filename: args.filename, content: limited.text },
                    {
                        sizeBytes: stat.size,
                        readBytes: bytesToRead,
                        truncated,
                        maxBytes
                    }
                );
            } finally {
                await handle.close();
            }
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

// ==========================================
// 🛠️ 工具 3: write_file (写入文件)
// ==========================================
export class WriteFileTool extends BaseAgentTool {
    readonly name = 'write_file';
    readonly permission = 'write' as const;
    readonly riskLevel = 'write' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'write_file',
            description: '在安全沙盒内创建新文件或覆盖已有文件，写入指定的文本内容',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: '目标文件路径，例如: output.md' },
                    content: { type: 'string', description: '要写入的完整文本内容' }
                },
                required: ['filename', 'content']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { filename?: unknown; content?: unknown };
        const errors: string[] = [];
        if (typeof typed.filename !== 'string' || !typed.filename.trim()) errors.push('filename must be a non-empty string');
        if (typeof typed.content !== 'string') errors.push('content must be a string');
        return errors;
    }

    async execute(args: { filename: string, content: string }): Promise<ToolResult> {
        try {
            const safePath = resolveSafePath(args.filename);

            await fs.mkdir(path.dirname(safePath), { recursive: true });

            await fs.writeFile(safePath, args.content, 'utf-8');
            return this.ok(
                { filename: args.filename, bytesWritten: Buffer.byteLength(args.content, 'utf-8') },
                { message: `file written: ${args.filename}` }
            );
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}
