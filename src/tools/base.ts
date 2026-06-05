import OpenAI from 'openai';

/**
 * 所有 Agent 工具的父类模板
 */
export abstract class BaseAgentTool {
    // 工具的名字，例如 'execute_shell'
    // abstract readonly name: string;

    // 给大模型看的工具说明书
    abstract readonly schema: OpenAI.Chat.Completions.ChatCompletionTool;

    // 真正执行工具的本地异步代码
    abstract execute(args: any): Promise<string>;
}
