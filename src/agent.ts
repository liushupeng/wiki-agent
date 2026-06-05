// src/agent.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { IAgent, IMemory, IToolRegistry, AgentConfig, IAgentTool } from './types.js';

dotenv.config();

/**
 * 1. 工具注册中心依然稳固支持 IToolRegistry
 */
export class ToolRegistry implements IToolRegistry {
    private tools = new Map<string, IAgentTool>();

    register(tool: IAgentTool): void {
        this.tools.set(tool.name, tool);
        console.log(`🔧 [Claude Mini 注册中心] 成功挂载原子工具: [${tool.name}]`);
    }

    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return Array.from(this.tools.values()).map(t => t.schema);
    }

    async execute(name: string, argsStr: string): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`未找到工具: ${name}`);
        return await tool.execute(JSON.parse(argsStr));
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }
}

/**
 * 2. 核心全自主 Planning 大脑实现
 */
export class ClaudeMiniAgent implements IAgent {
    private client: OpenAI;

    constructor(
        public config: AgentConfig,
        public memory: IMemory,
        public registry: IToolRegistry
    ) {
        this.client = new OpenAI({
            baseURL: process.env.DEEPSEEK_BASE_URL,
            apiKey: process.env.DEEPSEEK_API_KEY
        });
    }

    /**
     * 🔥 自主自适应规划控制循环 (Agent Loop)
     */
    async run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string> {
        // 将用户的原始长指令压入记忆芯片
        this.memory.append({ role: "user", content: userInstruction });

        let keepLooping = true;
        let stepCount = 0;
        let finalOutput = "";

        while (keepLooping) {
            stepCount++;

            // 防防御性安全熔断，防止大模型陷入死循环疯狂烧你的 Token
            if (stepCount > this.config.maxLoopSteps) {
                console.log(`\n🚨 [安全熔断] 侦测到当前任务链式思考已达 ${this.config.maxLoopSteps} 步上限，强行终止。`);
                break;
            }

            console.log(`\n🧠 [Agent Planning] 正在进行第 ${stepCount} 轮自适应任务拆解与评估...`);

            try {
                // 让大模型全面审视当前的上下文记忆与前几步工具的回执结果
                const stream = await this.client.chat.completions.create({
                    model: this.config.modelName,
                    messages: this.memory.getMessages() as any,
                    temperature: this.config.temperature,
                    reasoning_effort: "high",
                    tools: this.registry.getSchemas().length > 0 ? this.registry.getSchemas() : undefined,
                    stream: true,
                });

                let currentContent = "";
                let toolCallsBuffer: any[] = [];

                // 流式接收大模型的本次决策思考
                for await (const chunk of stream) {
                    const delta = chunk.choices[0]?.delta;
                    const content = delta?.content || "";

                    // 将大模型的 Thinking 文本流式打字回终端
                    if (content) {
                        currentContent += content;
                        onTextChunk(content);
                    }

                    // 收集潜在的工具调用申请，拼凑成完整的工具调用指令
                    if (delta?.tool_calls) {
                        for (const toolCallDelta of delta.tool_calls) {
                            const index = toolCallDelta.index;
                            if (!toolCallsBuffer[index]) {
                                toolCallsBuffer[index] = {
                                    id: toolCallDelta.id || "",
                                    type: "function",
                                    function: { name: toolCallDelta.function?.name || "", arguments: "" }
                                };
                            }
                            if (toolCallDelta.function?.arguments) {
                                toolCallsBuffer[index].function.arguments += toolCallDelta.function.arguments;
                            }
                        }
                    }
                }

                // 组装本次大模型的思考与决策模型
                const aiMessage: OpenAI.Chat.Completions.ChatCompletionMessage = {
                    role: 'assistant',
                    content: currentContent || null,
                    refusal: null,

                    ...(toolCallsBuffer.length > 0 && {
                        tool_calls: toolCallsBuffer.filter(Boolean)
                    })
                };

                // 必须立刻把大模型的这次决策和思考过程死死记入历史，否则后续上下文契约错乱报错
                this.memory.append(aiMessage as OpenAI.Chat.Completions.ChatCompletionMessage);

                // 决策分支检查：大模型是否需要申请调用Tool
                if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                    console.log(`\n⚙️  [Planning 决策] 大模型判断当前任务未完成，申请执行本地工具...`);

                    for (const toolCall of aiMessage.tool_calls) {
                        if (toolCall.type !== "function") {
                            console.warn(`⚠️ 警告：目前仅支持 function 类型的工具调用，跳过这个 ${toolCall.type} 类型的调用请求。`);
                            continue;
                        }

                        const toolName = toolCall.function.name;
                        const toolArgsStr = toolCall.function.arguments;

                        if (this.registry.has(toolName)) {
                            console.log(`🔌 [正在激活] 原子工具: [${toolName}] -> 参数: ${toolArgsStr}`);

                            // 动态反射执行真实的文件读写或系统 Shell 命令
                            const observationText = await this.registry.execute(toolName, toolArgsStr);

                            console.log(`💾 [工具反馈成功]`);

                            // 将物理世界的真实回执，以 role: "tool" 身份喂回记忆芯片
                            this.memory.append({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: observationText
                            });
                        } else {
                            console.warn(`⚠️ 无法匹配到注册工具: ${toolName}`);
                        }
                    }

                    console.log(`📡 [Replanning] 多步工具回执已成功同步，正在驱动大脑进入下一轮修正思考...`);
                } else {
                    // 终结条件：大模型没有输出任何 tool_calls，说明它已经通过之前的工具回执完全达成了目标
                    finalOutput = currentContent;
                    keepLooping = false; // 优雅切断 while 循环，长任务圆满达成！
                }

            } catch (error: any) {
                console.error(`🚨 [核心状态机故障]: ${error.message}`);
                keepLooping = false;
            }
        }

        return finalOutput;
    }
}
