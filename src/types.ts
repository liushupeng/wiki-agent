import OpenAI from 'openai';

// Agent 运行时的配置项
export interface AgentConfig {
    modelName: string;
    temperature: number;
    maxLoopSteps: number; // 防烧卡熔断步数
}

// Agent 核心契约接口
export interface IAgent {
    config: AgentConfig;
    memory: IMemory;
    registry: IToolRegistry;
    run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string>;
}

// Memory 核心契约接口
export interface IMemory {
    getMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    append(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void;
    clear(): void;
}

// IAgentTool 核心契约接口
export interface IAgentTool {
    readonly name: string;
    readonly schema: OpenAI.Chat.Completions.ChatCompletionTool;
    execute(args: any): Promise<string>;
}

// ToolRegistry 核心契约接口
export interface IToolRegistry {
    register(tool: IAgentTool): void;
    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[];
    execute(name: string, argsStr: string): Promise<string>;
    has(name: string): boolean;
}
