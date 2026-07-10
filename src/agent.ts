// src/agent.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { IAgent, IMemory, IToolRegistry, AgentConfig, ToolResult } from './types.js';
import { Color } from './cli/colors.js';
import { PermissionPolicy } from './permissions.js';
import { appendToolCallDeltas, buildSkippedToolResult, buildToolCalls, FunctionToolCall, isFunctionToolCall, ToolExecutionResult } from './protocol/toolCalls.js';
import { preview, TerminationReason, TraceLogger } from './trace.js';
import { ToolExecutor } from './tools/executor.js';
import { parseJsonForTrace } from './utils/json.js';

dotenv.config();

type StepResult =
    | { type: 'continue' }
    | { type: 'final'; content: string };

/**
 * 核心全自主 Planning 大脑实现
 */
export class WikiAgent implements IAgent {
    private client: OpenAI;
    private toolExecutor: ToolExecutor;

    constructor(
        public config: AgentConfig,
        public memory: IMemory,
        public registry: IToolRegistry
    ) {
        this.toolExecutor = new ToolExecutor(
            registry,
            new PermissionPolicy(config.approvalMode ?? 'prompt'),
            config.requestApproval
        );
        this.client = new OpenAI({
            baseURL: process.env.DEEPSEEK_BASE_URL,
            apiKey: process.env.DEEPSEEK_API_KEY
        });
    }

    /**
     * 执行一次完整的 Agent loop。
     *
     * 这个方法只负责“任务生命周期”的主流程：把用户输入写入 memory、
     * 循环执行模型决策、处理熔断和系统错误，并在最后写入 run_end trace。
     * 单步模型调用、工具调用调度和单个工具执行分别拆在 runStep()、
     * callModel()、handleToolCalls() 和 executeToolCall() 中。
     *
     * 流程图：
     *
     * User instruction
     *   -> append user message to memory
     *   -> write run_start trace
     *   -> loop step 1..maxLoopSteps
     *        -> runStep()
     *             -> callModel()
     *             -> append assistant message to memory
     *             -> write assistant_message trace
     *             -> has tool_calls?
     *                  yes -> handleToolCalls()
     *                         -> execute read-only tools in parallel
     *                         -> execute side-effect tools serially
     *                         -> append tool messages to memory
     *                         -> continue loop for replanning
     *                  no  -> return final answer
     *        -> maxLoopSteps exceeded?
     *             yes -> terminate with max_loop_steps
     *        -> system error?
     *             yes -> terminate with system_error
     *   -> write run_end trace with terminationReason
     *   -> return final answer text
     */
    async run(userInstruction: string, onTextChunk: (text: string) => void): Promise<string> {
        // 将用户的原始长指令压入记忆芯片
        this.memory.append({ role: "user", content: userInstruction });
        const traceLogger = new TraceLogger(this.config.traceDir);
        await traceLogger.write({ type: 'run_start', instruction: userInstruction, at: new Date().toISOString() });

        let stepCount = 0;
        let finalOutput = "";
        let terminationReason: TerminationReason = "completed";

        while (true) {
            stepCount++;

            // 防防御性安全熔断，防止大模型陷入死循环疯狂烧你的 Token
            if (stepCount > this.config.maxLoopSteps) {
                console.log(Color.red(`\n🚨 [安全熔断] 侦测到当前任务链式思考已达步数上限 (${this.config.maxLoopSteps} 步)，为保护您的账户额度，已强制熔断。`));
                terminationReason = "max_loop_steps";
                break;
            }

            try {
                const stepResult = await this.runStep(stepCount, traceLogger, onTextChunk);
                if (stepResult.type === 'final') {
                    finalOutput = stepResult.content;
                    break;
                }
            } catch (error: any) {
                console.log(Color.red(`\n🚨 [系统级严重故障拦截]: ${error.message}`));
                terminationReason = "system_error";
                break;
            }
        }

        await this.writeRunEnd(traceLogger, finalOutput, terminationReason);
        return finalOutput;
    }

    private async runStep(
        step: number,
        traceLogger: TraceLogger,
        onTextChunk: (text: string) => void
    ): Promise<StepResult> {
        console.log(Color.cyan(`\n🧠 [Step ${step}] Agent 正在审视环境并推演下一步规划...`));
        await traceLogger.write({ type: 'step_start', step, at: new Date().toISOString() });

        const aiMessage = await this.callModel(onTextChunk);
        const assistantText = this.getAssistantText(aiMessage);

        // 必须立刻把大模型的这次决策和思考过程记入历史，否则后续上下文契约会错乱。
        this.memory.append(aiMessage as OpenAI.Chat.Completions.ChatCompletionMessage);
        await traceLogger.write({
            type: 'assistant_message',
            step,
            contentPreview: preview(assistantText),
            toolCalls: (aiMessage.tool_calls ?? []).filter(isFunctionToolCall).map(call => call.function.name),
            at: new Date().toISOString()
        });

        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            await this.handleToolCalls(aiMessage.tool_calls, step, traceLogger);
            console.log(Color.cyan(`📡 [Replanning] 数据链已更新，重新唤醒大脑决策...`));
            return { type: 'continue' };
        }

        // 终结条件：大模型没有输出任何 tool_calls，说明它已经通过之前的工具回执完成任务。
        return { type: 'final', content: assistantText };
    }

    private async callModel(onTextChunk: (text: string) => void): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
        // 让大模型全面审视当前的上下文记忆与前几步工具的回执结果
        const toolSchemas = this.registry.getSchemas();
        const stream = await this.client.chat.completions.create({
            model: this.config.modelName,
            messages: this.memory.getMessages() as any,
            temperature: this.config.temperature,
            reasoning_effort: "high",
            tools: toolSchemas.length > 0 ? toolSchemas : undefined,
            stream: true,
        });

        let currentContent = "";
        const toolCallsBuffer: Parameters<typeof buildToolCalls>[0] = [];

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
                appendToolCallDeltas(toolCallsBuffer, delta.tool_calls);
            }
        }

        // 组装本次大模型的思考与决策消息
        const aiMessage: OpenAI.Chat.Completions.ChatCompletionMessage = {
            role: 'assistant',
            content: currentContent || null,
            refusal: null,

            ...(toolCallsBuffer.length > 0 && {
                tool_calls: buildToolCalls(toolCallsBuffer)
            })
        };

        return aiMessage;
    }

    /**
     * 从 assistant message 中提取可展示/可写入 trace 的纯文本。
     *
     * callModel() 只返回协议层的 aiMessage，避免同时维护 aiMessage.content
     * 和额外的 streaming 文本副本。需要文本时统一从这里读取；如果模型本轮
     * 只返回 tool_calls 而没有文本内容，则返回空字符串。
     */
    private getAssistantText(aiMessage: OpenAI.Chat.Completions.ChatCompletionMessage): string {
        return typeof aiMessage.content === 'string' ? aiMessage.content : '';
    }

    private async handleToolCalls(
        toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
        step: number,
        traceLogger: TraceLogger
    ): Promise<void> {
        const executableCalls = toolCalls
            .map((toolCall, index) => ({ toolCall, index }))
            .filter((item): item is { toolCall: FunctionToolCall; index: number } => isFunctionToolCall(item.toolCall));

        const skippedCalls = toolCalls
            .map((toolCall, index) => ({ toolCall, index }))
            .filter(({ toolCall }) => toolCall.type !== "function")
            .map(({ toolCall, index }) => {
                console.warn(Color.yellow(`⚠️ 警告：目前仅支持 function 类型的工具调用，跳过这个 ${toolCall.type} 类型的调用请求。`));
                return buildSkippedToolResult(toolCall as any, index);
            });

        const readOnlyCalls = executableCalls.filter(({ toolCall }) => this.registry.getTool(toolCall.function.name)?.isReadOnly);
        const serialCalls = executableCalls.filter(({ toolCall }) => !this.registry.getTool(toolCall.function.name)?.isReadOnly);

        const readResults = await Promise.all(
            readOnlyCalls.map(({ toolCall, index }) => this.executeToolCall(toolCall, index, step, traceLogger))
        );

        const serialResults: ToolExecutionResult[] = [];
        for (const { toolCall, index } of serialCalls) {
            serialResults.push(await this.executeToolCall(toolCall, index, step, traceLogger));
        }

        [...skippedCalls, ...readResults, ...serialResults]
            .sort((a, b) => a.originalIndex - b.originalIndex)
            .forEach(result => this.memory.append(result.toolMessage));
    }

    private async writeRunEnd(traceLogger: TraceLogger, finalOutput: string, terminationReason: TerminationReason): Promise<void> {
        await traceLogger.write({
            type: 'run_end',
            finalOutputPreview: preview(finalOutput),
            terminationReason,
            at: new Date().toISOString()
        });
    }

    private async executeToolCall(
        toolCall: FunctionToolCall,
        originalIndex: number,
        step: number,
        traceLogger: TraceLogger
    ): Promise<ToolExecutionResult> {
        const toolName = toolCall.function.name;
        const toolArgsStr = toolCall.function.arguments;
        const startedAt = Date.now();

        console.log(Color.magenta(`🔌 [激活工具] [${toolName}] -> 参数: ${toolArgsStr}`));

        const observation = await this.toolExecutor.execute(toolName, toolArgsStr);
        const observationText = JSON.stringify(observation);
        await this.writeToolResultTrace(traceLogger, {
            step,
            toolName,
            toolArgsStr,
            observation,
            observationText,
            durationMs: Date.now() - startedAt
        });

        return {
            originalIndex,
            toolMessage: {
                role: "tool",
                tool_call_id: toolCall.id,
                content: observationText
            }
        };
    }

    private async writeToolResultTrace(
        traceLogger: TraceLogger,
        input: {
            step: number;
            toolName: string;
            toolArgsStr: string;
            observation: ToolResult;
            observationText: string;
            durationMs: number;
        }
    ): Promise<void> {
        await traceLogger.write({
            type: 'tool_result',
            step: input.step,
            toolName: input.toolName,
            args: parseJsonForTrace(input.toolArgsStr),
            status: input.observation.status,
            durationMs: input.durationMs,
            observationPreview: preview(input.observationText),
            at: new Date().toISOString()
        });
    }
}
