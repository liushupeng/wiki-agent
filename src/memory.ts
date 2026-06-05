import OpenAI from 'openai';
import { IMemory } from './types.js';

export class MemoryManager implements IMemory {
    // 内部私有数组，锁死所有对话历史
    private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    /**
     * 构造函数：初始化时必须灌入最核心的 System Prompt
     * @param systemPrompt 智能体的灵魂底层设定
     */
    constructor(systemPrompt: string) {
        if (systemPrompt.trim()) {
            this.history.push({
                role: "system",
                content: systemPrompt.trim()
            });
        }
    }

    /**
     * 契约实现：获取全量上下文消息
     */
    getMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        // 返回浅拷贝副本，防止外部直接操作导致内部状态混乱
        return [...this.history];
    }

    /**
     * 契约实现：安全追加单条消息
     */
    append(message: OpenAI.Chat.Completions.ChatCompletionMessage): void {
        if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
            // 防御性编程：如果既没有文本又没有工具调用，属于空消息，直接拦截
            return;
        }
        this.history.push(message);
    }

    /**
     * 契约实现：一键清空记忆（但由于系统性格不能丢，我们会保留首位的 system 提示词）
     */
    clear(): void {
        const systemMsg = this.history.find(msg => msg.role === "system");
        this.history = systemMsg ? [systemMsg] : [];
        console.log("🧹 [MemoryManager] 滚动区历史已被安全释放，已恢复初始 System 设定。");
    }

    /**
     * 高阶扩展功能：查看当前记忆池里的总轮数（不包含 system 提示词）
     */
    getRoundCount(): number {
        return this.history.filter(msg => msg.role === "user").length;
    }
}
