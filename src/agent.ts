// src/agent.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { IAgent, IMemory, IToolRegistry, AgentConfig, IAgentTool } from './types.js';

dotenv.config();

const Color = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`
};

/**
 * 1. 工具注册中心依然稳固支持 IToolRegistry
 */
export class ToolRegistry implements IToolRegistry {
    private tools = new Map<string, IAgentTool>();

    register(tool: IAgentTool): void {
        this.tools.set(tool.name, tool);
        console.log(Color.green(`🔧 [Claude Mini 注册中心] 成功挂载原子工具: [${tool.name}]`));
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
                console.log(Color.red(`\n🚨 [安全熔断] 侦测到当前任务链式思考已达步数上限 (${this.config.maxLoopSteps} 步)，为保护您的账户额度，已强制熔断。`));
                break;
            }

            console.log(Color.cyan(`\n🧠 [Step ${stepCount}] Agent 正在审视环境并推演下一步规划...`));

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
                    for (const toolCall of aiMessage.tool_calls) {
                        if (toolCall.type !== "function") {
                            console.warn(Color.yellow(`⚠️ 警告：目前仅支持 function 类型的工具调用，跳过这个 ${toolCall.type} 类型的调用请求。`));
                            continue;
                        }

                        const toolName = toolCall.function.name;
                        const toolArgsStr = toolCall.function.arguments;

                        if (this.registry.has(toolName)) {
                            console.log(Color.magenta(`🔌 [激活工具] [${toolName}] -> 参数: ${toolArgsStr}`));

                            let observationText = "";
                            try {
                                observationText = await this.registry.execute(toolName, toolArgsStr);
                                console.log(Color.green(`💾 [工具反馈成功]`));
                            } catch (toolError: any) {
                                // 如果物理工具执行失败，捕捉它、不崩溃、做成 Observation 喂给大模型！
                                observationText = JSON.stringify({
                                    status: "runtime_error",
                                    error: toolError.message,
                                    hint: "请检查您的参数格式、路径正确性或命令合法性，修正后重试。"
                                });
                                console.log(Color.yellow(`⚠️ [运行时自愈] 工具执行发生异常，已将错误捕获并回喂给大模型进行 Replanning。`));
                            }

                            // 将物理世界的真实回执，以 role: "tool" 身份喂回记忆芯片
                            this.memory.append({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: observationText
                            });
                        } else {
                            console.warn(Color.yellow(`⚠️ 无法匹配到注册工具: ${toolName}`));
                        }
                    }

                    console.log(Color.cyan(`📡 [Replanning] 数据链已更新，重新唤醒大脑决策...`));
                } else {
                    // 终结条件：大模型没有输出任何 tool_calls，说明它已经通过之前的工具回执完全达成了目标
                    finalOutput = currentContent;
                    keepLooping = false; // 优雅切断 while 循环，长任务圆满达成！
                }

            } catch (error: any) {
                console.log(Color.red(`\n🚨 [系统级严重故障拦截]: ${error.message}`));
                keepLooping = false;
            }
        }

        return finalOutput;
    }
}
