import OpenAI from 'openai';

// +-----------------------------------------------------------+
// |                         IAgent                            |
// +-----------------------------------------------------------+
// | LLM(AgentConfig) | Tool(IToolRegistry) | Memory(IMemory)  |
// +-----------------------------------------------------------+

// Agent 运行时的配置项
export interface AgentConfig {
    modelName: string;
    temperature: number;
    maxLoopSteps: number; // 熔断步数
    traceDir?: string;
    approvalMode?: ApprovalMode;
    requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
}

// Memory 核心契约接口
export interface IMemory {
    getMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    append(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void;
    clear(): void;
}

export type ToolPermission = 'read' | 'write' | 'shell' | 'rag' | 'mcp';
export type ToolRiskLevel = 'safe' | 'write' | 'network' | 'shell' | 'dangerous';

/**
 * 运行时审批模式，表示“如果某次工具调用需要审批，系统应该怎么处理”。
 *
 * 它是全局配置，不是单次工具调用的最终结果。单次工具调用的最终结果
 * 由 PermissionPolicy 根据 ApprovalMode、工具风险和工具参数计算得到。
 *
 * - prompt: write/shell/network 工具执行前先询问用户。
 * - auto: 不弹出确认，直接执行已通过风险检查的工具；dangerous 工具和被拦截的 shell 命令仍会失败。
 * - deny: 允许安全只读工具，拒绝所有需要审批的工具。
 */
export const APPROVAL_MODES = ['auto', 'prompt', 'deny'] as const;
export type ApprovalMode = typeof APPROVAL_MODES[number];

export type ToolResult<T = unknown> = {
    status: 'success' | 'error' | 'invalid_args' | 'security_error' | 'approval_required' | 'approval_denied' | 'execution_failed' | 'runtime_error';
    data?: T;
    error?: string;
    metadata?: Record<string, unknown>;
};

export type ApprovalRequest = {
    toolName: string;
    riskLevel: ToolRiskLevel;
    reason: string;
    args: unknown;
};

// IAgentTool 核心契约接口
export interface IAgentTool {
    readonly name: string;
    readonly permission: ToolPermission;
    readonly riskLevel: ToolRiskLevel;
    readonly isReadOnly: boolean;
    readonly requiresApproval: boolean;
    readonly schema: OpenAI.Chat.Completions.ChatCompletionTool;
    validateArgs?(args: unknown): string[];
    execute(args: any): Promise<ToolResult>;
}

// ToolRegistry 核心契约接口
export interface IToolRegistry {
    register(tool: IAgentTool): void;
    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[];
    getTool(name: string): IAgentTool | undefined;
    execute(name: string, argsStr: string): Promise<ToolResult>;
    has(name: string): boolean;
}

// Agent 核心契约接口
export interface IAgent {
    config: AgentConfig;
    memory: IMemory;
    registry: IToolRegistry;
    run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string>;
}
