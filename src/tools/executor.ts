import { Color } from '../cli/colors.js';
import { PermissionPolicy } from '../permissions.js';
import { TraceLogger } from '../trace.js';
import { ApprovalRequest, IAgentTool, IToolRegistry, ToolResult } from '../types.js';
import { parseToolArguments } from '../utils/json.js';

type ParsedToolArgs =
    | { status: 'valid'; args: unknown }
    | { status: 'invalid'; result: ToolResult };

export class ToolExecutor {
    constructor(
        private readonly registry: IToolRegistry,
        private readonly permissionPolicy: PermissionPolicy,
        private readonly requestApproval?: (request: ApprovalRequest) => Promise<boolean>
    ) {}

    async execute(toolName: string, toolArgsStr: string, traceLogger?: TraceLogger): Promise<ToolResult> {
        try {
            const tool = this.registry.getTool(toolName);
            if (!tool) {
                throw new Error(`未找到工具: ${toolName}`);
            }

            const parsedArgs = this.validateToolArgs(tool, toolArgsStr);
            if (parsedArgs.status === 'invalid') {
                return parsedArgs.result;
            }

            // PermissionPolicy 只做决策；ToolExecutor 把 allow/ask/deny 转换成执行、人工审批或拒绝 observation。
            const decision = this.permissionPolicy.evaluate(tool, parsedArgs.args);
            await traceLogger?.write({
                type: 'permission_decision',
                level: 'debug',
                toolName,
                action: decision.action,
                reason: decision.reason,
                riskLevel: tool.riskLevel,
                at: new Date().toISOString()
            });

            if (decision.action === 'deny') {
                return {
                    status: 'security_error',
                    error: decision.reason,
                    metadata: { toolName, riskLevel: tool.riskLevel }
                };
            }

            if (decision.action === 'ask') {
                const approved = await this.requestToolApproval(tool, parsedArgs.args, decision.reason);
                if (!approved) {
                    return {
                        status: 'approval_denied',
                        error: `user denied tool execution: ${toolName}`,
                        metadata: { toolName, riskLevel: tool.riskLevel, reason: decision.reason }
                    };
                }
            }

            return await this.executeApprovedTool(toolName, toolArgsStr);
        } catch (toolError: any) {
            return this.buildRuntimeToolError(toolError);
        }
    }

    private validateToolArgs(tool: IAgentTool, toolArgsStr: string): ParsedToolArgs {
        const parsedArgs = parseToolArguments(toolArgsStr);
        if (!parsedArgs.ok) {
            return {
                status: 'invalid',
                result: { status: 'invalid_args', error: `invalid JSON arguments: ${parsedArgs.error}` }
            };
        }

        const validationErrors = tool.validateArgs?.(parsedArgs.value) ?? [];
        if (validationErrors.length > 0) {
            return {
                status: 'invalid',
                result: { status: 'invalid_args', error: validationErrors.join('; ') }
            };
        }

        return { status: 'valid', args: parsedArgs.value };
    }

    private async requestToolApproval(tool: IAgentTool, args: unknown, reason: string): Promise<boolean> {
        if (!this.requestApproval) return false;

        return this.requestApproval({
            toolName: tool.name,
            riskLevel: tool.riskLevel,
            reason,
            args
        });
    }

    private async executeApprovedTool(toolName: string, toolArgsStr: string): Promise<ToolResult> {
        const startedAt = Date.now();
        const observation = await this.registry.execute(toolName, toolArgsStr);
        const durationMs = Date.now() - startedAt;
        const message = `💾 [工具完成] [${toolName}] · 状态=${observation.status} · 耗时=${durationMs}ms${summarizeToolResult(observation)}`;
        console.log(observation.status === 'success' ? Color.green(message) : Color.yellow(message));
        return observation;
    }

    private buildRuntimeToolError(toolError: any): ToolResult {
        console.log(Color.yellow(`⚠️ [运行时自愈] 工具执行发生异常，已将错误捕获并回喂给大模型进行 Replanning。`));
        return {
            status: "runtime_error",
            error: toolError.message,
            metadata: { hint: "请检查您的参数格式、路径正确性或命令合法性，修正后重试。" }
        };
    }
}

function summarizeToolResult(result: ToolResult): string {
    const metadataCount = result.metadata?.count;
    if (typeof metadataCount === 'number') {
        return ` · 结果=${metadataCount} 条${result.metadata?.truncated === true ? '（已截断）' : ''}`;
    }

    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return '';
    const data = result.data as Record<string, unknown>;

    for (const key of ['matches', 'chunks', 'files', 'items', 'tools', 'entries']) {
        if (Array.isArray(data[key])) return ` · ${key}=${data[key].length} 条`;
    }
    for (const key of ['content', 'stdout', 'output']) {
        if (typeof data[key] === 'string') return ` · ${key}=${data[key].length} 字符`;
    }

    return '';
}
