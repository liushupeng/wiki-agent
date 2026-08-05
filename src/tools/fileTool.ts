import fs from 'fs/promises';
import { BaseAgentTool } from './base.js';
import { resolveSafePath } from '../sandbox.js';
import { defaultWriteScopes, loadWriteScopes, resolveWriteScopePath, WriteScopesConfig } from '../config/writeScopes.js';
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
    readonly schema: ReturnType<typeof createWriteFileSchema>;

    constructor(private readonly writeScopes: WriteScopesConfig = defaultWriteScopes()) {
        super();
        this.schema = createWriteFileSchema(writeScopes);
    }

    static async create(): Promise<WriteFileTool> {
        return new WriteFileTool(await loadWriteScopes());
    }

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { filename?: unknown; content?: unknown; scope?: unknown };
        const errors: string[] = [];
        if (typeof typed.filename !== 'string' || !typed.filename.trim()) errors.push('filename must be a non-empty string');
        if (typeof typed.content !== 'string') errors.push('content must be a string');
        if (typed.scope !== undefined && (typeof typed.scope !== 'string' || !this.writeScopes.scopes.some(scope => scope.name === typed.scope))) {
            errors.push(`scope must be one of: ${this.writeScopes.scopes.map(scope => scope.name).join(', ')}`);
        }
        return errors;
    }

    async execute(args: { filename: string, content: string, scope?: string }): Promise<ToolResult> {
        try {
            const scopeName = args.scope ?? this.writeScopes.defaultScope;
            const scope = this.writeScopes.scopes.find(item => item.name === scopeName);
            if (!scope) return this.error(`unknown write scope: ${scopeName}`);

            const targetPath = await resolveWriteScopePath(scope, args.filename);
            await fs.writeFile(targetPath, args.content, 'utf-8');
            return this.ok(
                { scope: scope.name, filename: args.filename, bytesWritten: Buffer.byteLength(args.content, 'utf-8') },
                { message: `file written: ${scope.name}/${args.filename}` }
            );
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

function createWriteFileSchema(writeScopes: WriteScopesConfig) {
    const scopeNames = writeScopes.scopes.map(scope => scope.name);
    const scopeDescription = writeScopes.scopes
        .map(scope => `${scope.name}: ${scope.description}`)
        .join('；');

    return {
        type: 'function' as const,
        function: {
            name: 'write_file',
            description: `在受配置约束的目录内创建新文件或覆盖已有文件。省略 scope 时使用默认作用域 "${writeScopes.defaultScope}"。可用作用域：${scopeDescription}`,
            parameters: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'string',
                        enum: scopeNames,
                        description: `目标写入作用域。仅可选择已配置名称；省略时使用 "${writeScopes.defaultScope}"。`
                    },
                    filename: { type: 'string', description: '相对于所选作用域根目录的文件路径，例如: output.md' },
                    content: { type: 'string', description: '要写入的完整文本内容' }
                },
                required: ['filename', 'content']
            }
        }
    };
}
