// src/agent.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { IAgent, IMemory, IToolRegistry, AgentConfig } from './types.js';
import { BaseAgentTool } from './tools/base.js';

dotenv.config();

/**
 * 1. 遵照契约实现工具注册中心
 */
export class ToolRegistry implements IToolRegistry {
    private tools = new Map<string, BaseAgentTool>();

    register(tool: BaseAgentTool): void {
        this.tools.set(tool.name, tool);
        console.log(`🔧 [Claude Mini 注册中心] 成功挂载原子工具: [${tool.name}]`);
    }

    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return Array.from(this.tools.values()).map(t => t.schema);
    }

    async execute(name: string, argsStr: string): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`未找到工具: ${name}`);
        const args = JSON.parse(argsStr);
        return await tool.execute(args);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }
}

/**
 * 2. 遵照契约实现 Claude Code Mini 主控大脑
 */
export class ClaudeMiniAgent implements IAgent {
    private client: OpenAI;

    constructor(
        public config: AgentConfig,
        public memory: IMemory,       // 外部注入的记忆组件
        public registry: IToolRegistry // 外部注入的工具组件
    ) {
        this.client = new OpenAI({
            baseURL: 'https://api.deepseek.com/v1',
            apiKey: process.env.DEEPSEEK_API_KEY
        });
    }

    /**
     * Agent 核心工作流驱动入口
     */
    async run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string> {
        console.log(`\n🤖 [Agent 工作流] 接收到复杂指令，启动自适应 Planning 机制...`);

        // 今天先将用户指令灌入记忆，并用最基础的单轮逻辑跑通地基
        this.memory.append({ role: "user", content: userInstruction });

        // Day 26-27 会在此处展开宏大的 while(true) Agent Loop
        // 今天我们先用一行伪代码占位，证明接口设计完全走通
        const mockReply = "【Claude Code Mini Day 22 架构握手成功】我已经理解了您的指令，组件架构契约已全部对齐。";
        onTextChunk(mockReply);

        this.memory.append({ role: "assistant", content: mockReply });
        return mockReply;
    }
}
