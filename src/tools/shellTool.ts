import { exec } from 'child_process';
import { BaseAgentTool } from './base.js';
import { ensureSandboxRoot } from '../sandbox.js';
import { limitText } from '../limits.js';
import { ToolResult } from '../types.js';

// 工具内保留一层危险 token 拦截；结构化 allowlist 和审批由 PermissionPolicy 处理。
const FORBIDDEN_KEYWORDS = ['rm', 'mv', 'del', 'erase', 'rmdir', 'rd', 'wget', 'curl', 'shutdown', 'fdisk', 'mkfs', 'format', 'chmod', 'chown'];

export class ShellExecuteTool extends BaseAgentTool {
    readonly name = 'execute_command';
    readonly permission = 'shell' as const;
    readonly riskLevel = 'shell' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'execute_command',
            description: '在受控的本地安全沙盒环境里执行非破坏性的系统终端命令（如 ls, pwd, git status 等）',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '要执行的纯终端 Shell 命令，例如："ls -la" 或 "pwd"'
                    }
                },
                required: ['command']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const command = (args as { command?: unknown }).command;
        return typeof command === 'string' && command.trim() ? [] : ['command must be a non-empty string'];
    }

    async execute(args: { command: string }): Promise<ToolResult> {
        const rawCommand = args.command.trim();

        const hasViolation = FORBIDDEN_KEYWORDS.some(keyword => {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            return regex.test(rawCommand);
        });

        if (hasViolation) {
            return this.securityError('command contains forbidden shell token');
        }

        const timeout = Number(process.env.SHELL_TIMEOUT_MS ?? 5000);
        const sandboxRoot = await ensureSandboxRoot();
        return new Promise<ToolResult>((resolve) => {
            exec(rawCommand, { cwd: sandboxRoot, timeout, maxBuffer: Number(process.env.SHELL_MAX_BUFFER_BYTES ?? 1024 * 1024) }, (error, stdout, stderr) => {
                const limitedStdout = limitText(stdout.trim());
                const limitedStderr = limitText(stderr.trim());
                const metadata = {
                    cwd: sandboxRoot,
                    timeoutMs: timeout,
                    stdoutTruncated: limitedStdout.truncated,
                    stderrTruncated: limitedStderr.truncated,
                    stdoutOriginalLength: limitedStdout.originalLength,
                    stderrOriginalLength: limitedStderr.originalLength
                };

                if (error) {
                    resolve(this.executionFailed(error.message, {
                        ...metadata,
                        code: error.code,
                        stderr: limitedStderr.text
                    }));
                    return;
                }

                resolve(this.ok({
                    command: rawCommand,
                    stdout: limitedStdout.text,
                    stderr: limitedStderr.text
                }, metadata));
            });
        });
    }
}
