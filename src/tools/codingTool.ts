import { exec, execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { limitText } from '../limits.js';
import { ToolResult } from '../types.js';
import { BaseAgentTool } from './base.js';
import { resolveExistingPathWithinRoot } from '../sandbox.js';
import { getWorkspaceRoot } from '../workspace.js';

export { getWorkspaceRoot } from '../workspace.js';

async function resolveWorkspacePath(targetPath: string): Promise<string> {
    return resolveExistingPathWithinRoot(getWorkspaceRoot(), targetPath, '工作区');
}

function execInWorkspace(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code?: string | number; error?: string }> {
    return new Promise(resolve => {
        exec(command, { cwd: getWorkspaceRoot(), timeout: timeoutMs, maxBuffer: Number(process.env.SHELL_MAX_BUFFER_BYTES ?? 1024 * 1024) }, (error, stdout, stderr) => {
            resolve({
                stdout,
                stderr,
                code: error?.code,
                error: error?.message
            });
        });
    });
}

function npmExecutable(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmScriptArgs(script: 'test' | 'build' | 'check:config'): string[] {
    return script === 'test' ? ['test'] : ['run', script];
}

function execNpmScriptInWorkspace(
    script: 'test' | 'build' | 'check:config',
    timeoutMs: number
): Promise<{ stdout: string; stderr: string; code?: string | number; error?: string }> {
    return new Promise(resolve => {
        execFile(
            npmExecutable(),
            npmScriptArgs(script),
            {
                cwd: getWorkspaceRoot(),
                timeout: timeoutMs,
                maxBuffer: Number(process.env.SHELL_MAX_BUFFER_BYTES ?? 1024 * 1024),
                // Windows 的 npm.cmd 需要 shell，否则 execFile 会 EINVAL
                ...(process.platform === 'win32' ? { shell: true } : {})
            },
            (error, stdout, stderr) => {
                const code = error?.code;
                resolve({
                    stdout,
                    stderr,
                    ...(code === undefined || code === null ? {} : { code }),
                    error: error?.message
                });
            }
        );
    });
}

export class ApplyPatchTool extends BaseAgentTool {
    readonly name = 'apply_patch';
    readonly permission = 'write' as const;
    readonly riskLevel = 'write' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'apply_patch',
            description: '在工作区内对单个文本文件执行精确替换。oldText 必须唯一匹配。',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: '相对于工作区根目录的文件路径' },
                    oldText: { type: 'string', description: '要替换的原始文本，必须唯一出现' },
                    newText: { type: 'string', description: '替换后的文本' }
                },
                required: ['filePath', 'oldText', 'newText']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const typed = args as { filePath?: unknown; oldText?: unknown; newText?: unknown };
        const errors: string[] = [];
        if (typeof typed.filePath !== 'string' || !typed.filePath.trim()) errors.push('filePath must be a non-empty string');
        if (typeof typed.oldText !== 'string' || !typed.oldText) errors.push('oldText must be a non-empty string');
        if (typeof typed.newText !== 'string') errors.push('newText must be a string');
        return errors;
    }

    async execute(args: { filePath: string; oldText: string; newText: string }): Promise<ToolResult> {
        try {
            const target = await resolveWorkspacePath(args.filePath);
            const content = await fs.readFile(target, 'utf-8');
            const occurrences = content.split(args.oldText).length - 1;

            if (occurrences !== 1) {
                return this.error(`oldText must match exactly once, found ${occurrences}`, { filePath: args.filePath });
            }

            const next = content.replace(args.oldText, args.newText);
            await fs.writeFile(target, next, 'utf-8');
            return this.ok({
                filePath: args.filePath,
                bytesWritten: Buffer.byteLength(next, 'utf-8')
            });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}

export class GitStatusTool extends BaseAgentTool {
    readonly name = 'git_status';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'git_status',
            description: '读取工作区 git status --short --branch 输出',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    };

    async execute(): Promise<ToolResult> {
        const result = await execInWorkspace('git status --short --branch', 5000);
        const stdout = limitText(result.stdout.trim());
        const stderr = limitText(result.stderr.trim());

        if (result.error) {
            return this.executionFailed(result.error, { code: result.code, stderr: stderr.text });
        }

        return this.ok({ stdout: stdout.text, stderr: stderr.text }, {
            workspaceRoot: getWorkspaceRoot(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated
        });
    }
}

export class GitDiffTool extends BaseAgentTool {
    readonly name = 'git_diff';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'git_diff',
            description: '读取工作区 git diff 输出，可选择 staged 或统计模式',
            parameters: {
                type: 'object',
                properties: {
                    staged: { type: 'boolean', description: '是否查看已暂存变更' },
                    statOnly: { type: 'boolean', description: '是否只返回 --stat 统计' }
                },
                required: []
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return [];
        const typed = args as { staged?: unknown; statOnly?: unknown };
        const errors: string[] = [];
        if (typed.staged !== undefined && typeof typed.staged !== 'boolean') errors.push('staged must be a boolean');
        if (typed.statOnly !== undefined && typeof typed.statOnly !== 'boolean') errors.push('statOnly must be a boolean');
        return errors;
    }

    async execute(args: { staged?: boolean; statOnly?: boolean } = {}): Promise<ToolResult> {
        const command = ['git diff', args.staged ? '--staged' : '', args.statOnly ? '--stat' : ''].filter(Boolean).join(' ');
        const result = await execInWorkspace(command, 10000);
        const stdout = limitText(result.stdout.trim());
        const stderr = limitText(result.stderr.trim());

        if (result.error) {
            return this.executionFailed(result.error, { code: result.code, stderr: stderr.text });
        }

        return this.ok({ command, stdout: stdout.text, stderr: stderr.text }, {
            workspaceRoot: getWorkspaceRoot(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated
        });
    }
}

export class RunTestsTool extends BaseAgentTool {
    readonly name = 'run_tests';
    readonly permission = 'shell' as const;
    readonly riskLevel = 'shell' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'run_tests',
            description: '在工作区运行测试或构建命令，默认执行 npm test',
            parameters: {
                type: 'object',
                properties: {
                    script: {
                        type: 'string',
                        enum: ['test', 'build', 'check:config'],
                        description: '允许执行的 npm script，默认 test'
                    },
                    timeoutMs: { type: 'number', description: '超时时间，默认 30000ms' }
                },
                required: []
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return [];
        const typed = args as { script?: unknown; timeoutMs?: unknown };
        const errors: string[] = [];
        if (typed.script !== undefined && !['test', 'build', 'check:config'].includes(String(typed.script))) {
            errors.push('script must be one of test, build, check:config');
        }
        if (typed.timeoutMs !== undefined && (typeof typed.timeoutMs !== 'number' || typed.timeoutMs <= 0)) errors.push('timeoutMs must be a positive number');
        return errors;
    }

    async execute(args: { script?: 'test' | 'build' | 'check:config'; timeoutMs?: number } = {}): Promise<ToolResult> {
        const script = args.script ?? 'test';
        const command = script === 'test' ? 'npm test' : `npm run ${script}`;
        const timeoutMs = Math.min(args.timeoutMs ?? 30000, Number(process.env.RUN_TESTS_MAX_TIMEOUT_MS ?? 120000));
        const result = await execNpmScriptInWorkspace(script, timeoutMs);
        const stdout = limitText(result.stdout.trim());
        const stderr = limitText(result.stderr.trim());

        if (result.error) {
            return this.executionFailed(result.error, {
                command,
                code: result.code,
                stderr: stderr.text,
                stdout: stdout.text,
                timeoutMs,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated
            });
        }

        return this.ok({ command, stdout: stdout.text, stderr: stderr.text }, {
            timeoutMs,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated
        });
    }
}
