import { ApprovalMode, IAgentTool, ToolRiskLevel } from './types.js';

/**
 * PermissionPolicy 对“某一次工具调用”给出的最终执行决策。
 *
 * 它和 ApprovalMode 的关系：
 * - ApprovalMode 是运行时配置，表示遇到需要审批的工具时整体采用 prompt/auto/deny 哪种模式。
 * - PermissionDecision 是单次工具调用的结果，表示这一次调用应该 allow/ask/deny。
 */

export type PermissionDecision =
    | { action: 'allow'; reason: string }
    | { action: 'deny'; reason: string }
    | { action: 'ask'; reason: string };

const DEFAULT_SHELL_ALLOWLIST = new Set([
    'pwd',
    'ls',
    'dir',
    'echo',
    'git',
    'npm',
    'pnpm',
    'yarn',
    'node',
    'npx',
    'tsc'
]);

const DANGEROUS_SHELL_TOKENS = [
    'rm',
    'mv',
    'del',
    'erase',
    'rmdir',
    'rd',
    'shutdown',
    'fdisk',
    'mkfs',
    'format',
    'chmod',
    'chown',
    'curl',
    'wget',
    'ssh',
    'scp'
];

export class PermissionPolicy {
    constructor(private readonly approvalMode: ApprovalMode = 'prompt') { }

    /**
     * 根据工具声明、工具参数和当前审批模式，判断这一次工具调用如何处理。
     *
     * 调用方应该按返回值执行：
     * - allow: 直接执行工具。
     * - ask: 调用 CLI/UI 的人工审批适配器，用户同意后再执行。
     * - deny: 不执行工具，把拒绝原因作为 observation 返回给模型。
     */
    evaluate(tool: IAgentTool, args: unknown): PermissionDecision {
        if (tool.riskLevel === 'dangerous') {
            return { action: 'deny', reason: 'tool is marked as dangerous' };
        }

        if (tool.permission === 'shell') {
            const shellDecision = this.evaluateShellCommand(tool, args);
            if (shellDecision.action === 'deny') return shellDecision;
        }

        if (tool.requiresApproval || this.requiresApprovalByRisk(tool.riskLevel)) {
            if (this.approvalMode === 'deny') {
                return { action: 'deny', reason: `approval required for ${tool.riskLevel} tool, but approval mode is deny` };
            }
            return {
                action: 'ask',
                reason: this.approvalMode === 'auto'
                    ? `explicit user approval is required for ${tool.riskLevel} tool even in auto mode`
                    : `approval required for ${tool.riskLevel} tool`
            };
        }

        return { action: 'allow', reason: 'safe read-only tool' };
    }

    private requiresApprovalByRisk(riskLevel: ToolRiskLevel): boolean {
        return ['write', 'network', 'shell', 'dangerous'].includes(riskLevel);
    }

    private evaluateShellCommand(tool: IAgentTool, args: unknown): PermissionDecision {
        const command = tool.name === 'run_tests'
            ? runTestsCommand(args)
            : typeof args === 'object' && args !== null && 'command' in args
                ? String((args as { command?: unknown }).command ?? '').trim()
                : '';

        if (!command) {
            return { action: 'deny', reason: 'shell command is empty' };
        }

        const normalized = command.toLowerCase();
        for (const token of DANGEROUS_SHELL_TOKENS) {
            if (new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(normalized)) {
                return { action: 'deny', reason: `shell command contains forbidden token: ${token}` };
            }
        }

        const executable = normalized.split(/\s+/)[0];
        if (!DEFAULT_SHELL_ALLOWLIST.has(executable)) {
            return { action: 'deny', reason: `shell executable is not allowlisted: ${executable}` };
        }

        return { action: 'ask', reason: `allowlisted shell command still requires approval: ${executable}` };
    }
}

function runTestsCommand(args: unknown): string {
    if (typeof args !== 'object' || args === null) return 'npm test';
    const script = String((args as { script?: unknown }).script ?? 'test');
    return script === 'test' ? 'npm test' : `npm run ${script}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
