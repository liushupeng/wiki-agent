import OpenAI from 'openai';
import { ToolPermission, ToolResult, ToolRiskLevel } from '../types.js';

/**
 * 所有 Agent 工具的父类模板
 */
export abstract class BaseAgentTool {
    /**
     * 工具的唯一名称。
     *
     * 这个名字会写入 tool schema，LLM 发起 tool call 时也会用同一个名字。
     * ToolRegistry 通过它查找具体工具实现。
     */
    abstract readonly name: string;

    /**
     * 暴露给 LLM 的工具说明书。
     *
     * 包含工具名、用途描述和 JSON 参数结构。模型只能根据这个 schema
     * 决定是否调用工具，以及生成什么参数。
     */
    abstract readonly schema: OpenAI.Chat.Completions.ChatCompletionTool;

    /**
     * 工具所属的权限类别，用于审计和策略判断。
     *
     * 例如 read/write/shell/rag。它描述工具访问的能力类型，
     * 不直接等同于风险等级。
     */
    readonly permission: ToolPermission = 'read';

    /**
     * 工具风险等级，用于 PermissionPolicy 判断是否需要审批或拒绝。
     *
     * safe 通常可直接执行；write/network/shell 通常需要人工确认；
     * dangerous 会被安全策略拒绝。
     */
    readonly riskLevel: ToolRiskLevel = 'safe';

    /**
     * 工具是否只读，用于 handleToolCalls() 的并发调度。
     *
     * true 表示工具不修改外部状态，可以和其他只读工具并发执行。
     * false 表示工具可能写文件、执行命令或修改环境，需要串行执行。
     */
    readonly isReadOnly: boolean = true;

    /**
     * 工具是否强制进入人工审批流程。
     *
     * 即使风险等级没有触发审批，具体工具也可以通过这个字段要求 HITL。
     * 最终是否执行仍由 PermissionPolicy 和运行时 approvalMode 共同决定。
     */
    readonly requiresApproval: boolean = false;

    validateArgs(_args: unknown): string[] {
        return [];
    }

    protected ok<T>(data: T, metadata?: Record<string, unknown>): ToolResult<T> {
        return { status: 'success', data, ...(metadata ? { metadata } : {}) };
    }

    protected error(error: string, metadata?: Record<string, unknown>): ToolResult {
        return { status: 'error', error, ...(metadata ? { metadata } : {}) };
    }

    protected invalidArgs(errors: string[]): ToolResult {
        return { status: 'invalid_args', error: errors.join('; ') };
    }

    protected securityError(error: string, metadata?: Record<string, unknown>): ToolResult {
        return { status: 'security_error', error, ...(metadata ? { metadata } : {}) };
    }

    protected executionFailed(error: string, metadata?: Record<string, unknown>): ToolResult {
        return { status: 'execution_failed', error, ...(metadata ? { metadata } : {}) };
    }

    // 真正执行工具的本地异步代码
    abstract execute(args: any): Promise<ToolResult>;
}
