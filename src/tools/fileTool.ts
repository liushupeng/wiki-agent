import path from 'path';
import fs from 'fs/promises';
import { BaseAgentTool } from './base.js';

// 核心安全守卫：强行锁定项目根目录下的 agent_sandbox
const SANDBOX_ROOT = path.resolve('C:\\AgentSandbox');

/**
 * 防逃逸绝对路径解析
 * @param targetPath 用户输入的相对路径
 * @returns 解析后的安全绝对路径
 * @throws 如果解析后的路径不在沙盒根目录内，则抛出安全异常
 */
function resolveSafePath(targetPath: string): string {
    // 1. 将用户/大模型输入的路径与沙盒根目录拼接，并解析掉所有的 ../ 或 ./
    const resolved = path.resolve(SANDBOX_ROOT, targetPath);

    // 2. 严格安全审计：判断解析后的绝对路径，是否依然以沙盒根目录开头
    if (!resolved.startsWith(SANDBOX_ROOT)) {
        throw new Error(`[安全拦截] 侦测到越权路径逃逸企图！目标路径 [${targetPath}] 不在安全沙盒内。`);
    }
    return resolved;
}

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

    async execute(args: { relativePath: string }): Promise<string> {
        try {
            const safePath = resolveSafePath(args.relativePath || '.');
            const files = await fs.readdir(safePath, { withFileTypes: true });

            const result = files.map(f => ({
                name: f.name,
                type: f.isDirectory() ? 'directory' : 'file'
            }));

            return JSON.stringify({ status: "success", data: result });
        } catch (error: any) {
            return JSON.stringify({ status: "error", message: error.message });
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
                    filename: { type: 'string', description: '相对于沙盒的文件路径，例如: src/main.py' }
                },
                required: ['filename']
            }
        }
    };

    async execute(args: { filename: string }): Promise<string> {
        try {
            const safePath = resolveSafePath(args.filename);
            const content = await fs.readFile(safePath, 'utf-8');
            return JSON.stringify({ status: "success", content });
        } catch (error: any) {
            return JSON.stringify({ status: "error", message: error.message });
        }
    }
}

// ==========================================
// 🛠️ 工具 3: write_file (写入文件)
// ==========================================
export class WriteFileTool extends BaseAgentTool {
    readonly name = 'write_file';
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

    async execute(args: { filename: string, content: string }): Promise<string> {
        try {
            const safePath = resolveSafePath(args.filename);

            // 自动确保多级父目录存在，防止因为没有文件夹而报错
            await fs.mkdir(path.dirname(safePath), { recursive: true });

            await fs.writeFile(safePath, args.content, 'utf-8');
            return JSON.stringify({ status: "success", message: `成功持久化写入至真实文件: [${args.filename}]` });
        } catch (error: any) {
            return JSON.stringify({ status: "error", message: error.message });
        }
    }
}
