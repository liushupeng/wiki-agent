import path from 'path';
import { exec } from 'child_process';
import { BaseAgentTool } from './base.js';

// 锁死命令执行的主战场：安全沙盒绝对路径
const SANDBOX_ROOT = path.resolve('C:\\AgentSandbox');

// 严苛的命令黑名单（防止破坏磁盘或恶意出海下载病毒）
const FORBIDDEN_KEYWORDS = ['rm', 'mv', 'wget', 'curl', 'shutdown', 'fdisk', 'mkfs', 'chmod'];

export class ShellExecuteTool extends BaseAgentTool {
    readonly name = 'execute_command';
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

    async execute(args: { command: string }): Promise<string> {
        const rawCommand = args.command.trim();

        // 🛡️ 安全防火墙第一关：黑名单关键词拦截
        const hasViolation = FORBIDDEN_KEYWORDS.some(keyword => {
            // 使用正则确保是独立的单词匹配，防止误伤（比如把名为 "farm" 的文件夹也拦截了）
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            return regex.test(rawCommand);
        });

        if (hasViolation) {
            return JSON.stringify({
                status: "security_error",
                message: `[安全机制拦截] 侦测到该命令包含高危黑名单关键词，已被拒绝执行。`
            });
        }

        // 🛡️ 安全防火墙第二关：强行拉起子进程并绑定执行路径
        return new Promise((resolve) => {
            // exec 会在后台悄悄孵化一个独立的系统子进程
            exec(rawCommand, { cwd: SANDBOX_ROOT, timeout: 5000 }, (error, stdout, stderr) => {
                if (error) {
                    // 命令跑失败了（比如语法错误），返回错误回执给大模型
                    resolve(JSON.stringify({
                        status: "execution_failed",
                        code: error.code,
                        message: error.message,
                        stderr: stderr.trim()
                    }));
                    return;
                }

                // 执行成功，将命令的标准输出打包回执
                resolve(JSON.stringify({
                    status: "success",
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                }));
            });
        });
    }
}
