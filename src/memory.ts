import OpenAI from 'openai';
import { getActiveSpan } from './trace/telemetry.js';
import { IMemory } from './types.js';
import { estimateMessagesSize } from './utils/tokenBudget.js';

type FunctionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
    type: "function";
    function: {
        name: string;
    };
};

function isFunctionToolCall(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall): toolCall is FunctionToolCall {
    return toolCall.type === "function" && "function" in toolCall;
}

type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type MidTermSummaryEntry = {
    text: string;
};

type LongTermMemoryItem = {
    text: string;
};

class ShortTermMemory {
    private messages: MemoryMessage[] = [];

    append(message: MemoryMessage): void {
        this.messages.push(message);
    }

    getMessages(): MemoryMessage[] {
        return [...this.messages];
    }

    replace(messages: MemoryMessage[]): void {
        this.messages = [...messages];
    }

    clear(): void {
        this.messages = [];
    }
}

class MidTermMemory {
    private entries: MidTermSummaryEntry[] = [];

    mergeMessages(messages: MemoryMessage[]): void {
        if (messages.length === 0) return;
        this.entries.push(...messages.map(msg => ({ text: summarizeMessage(msg) })));
    }

    toMessage(): MemoryMessage | undefined {
        if (this.entries.length === 0) return undefined;

        return {
            role: "system",
            content: `以下是较早上下文的自动压缩摘要，用于保持任务连续性：\n${this.entries.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n')}`
        };
    }

    getEntryCount(): number {
        return this.entries.length;
    }

    clear(): void {
        this.entries = [];
    }
}

class LongTermMemory {
    private items: LongTermMemoryItem[] = [];

    toMessage(): MemoryMessage | undefined {
        if (this.items.length === 0) return undefined;

        return {
            role: "system",
            content: `以下是长期记忆，用于保持跨任务连续性：\n${this.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
        };
    }

    getItemCount(): number {
        return this.items.length;
    }

    clear(): void {
        this.items = [];
    }
}

export class MemoryManager implements IMemory {
    private readonly systemMessage?: MemoryMessage;
    private readonly shortTerm = new ShortTermMemory();
    private readonly midTerm = new MidTermMemory();
    private readonly longTerm = new LongTermMemory();
    private readonly maxHistoryMessages: number;
    private readonly keepRecentMessages: number;
    private readonly maxHistoryChars: number;

    /**
     * 构造函数：初始化时必须灌入最核心的 System Prompt
     * @param systemPrompt 智能体的灵魂底层设定
     */
    constructor(systemPrompt: string, options: { maxHistoryMessages?: number; keepRecentMessages?: number } = {}) {
        this.maxHistoryMessages = options.maxHistoryMessages ?? Number(process.env.MEMORY_MAX_MESSAGES ?? 40);
        this.keepRecentMessages = options.keepRecentMessages ?? Number(process.env.MEMORY_KEEP_RECENT_MESSAGES ?? 18);
        this.maxHistoryChars = Number(process.env.MEMORY_MAX_CHARS ?? 60000);

        if (systemPrompt.trim()) {
            this.systemMessage = {
                role: "system",
                content: systemPrompt.trim()
            };
        }
    }

    /**
     * 契约实现：获取全量上下文消息
     * @returns 消息数组，包含 system + 历史对话
     */
    getMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return [
            ...(this.systemMessage ? [this.systemMessage] : []),
            ...[this.midTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...[this.longTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...this.shortTerm.getMessages()
        ];
    }

    /**
     * 契约实现：安全追加单条消息
     * @param message 要追加的消息，必须至少包含 content 或 tool_calls 中的一个，否则视为无效消息将被拦截
     *                这是一道防御性编程的安全防线，旨在防止大模型输出空消息导致的记忆污染和无效循环
     */
    append(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void {
        const toolCalls = 'tool_calls' in message ? message.tool_calls : undefined;
        if (!message.content && (!toolCalls || toolCalls.length === 0)) {
            // 防御性编程：如果既没有文本又没有工具调用，属于空消息，直接拦截
            return;
        }
        this.shortTerm.append(message);
        this.compactIfNeeded();
    }

    /**
     * 契约实现：一键清空记忆（但由于系统性格不能丢，我们会保留首位的 system 提示词）
     * @returns void
     */
    clear(): void {
        this.shortTerm.clear();
        this.midTerm.clear();
        this.longTerm.clear();
        console.log("🧹 [MemoryManager] 滚动区历史已被安全释放，已恢复初始 System 设定。");
    }

    /**
     * 高阶扩展功能：查看当前记忆池里的总轮数（不包含 system 提示词）
     * @return 当前记忆轮数
     */
    getRoundCount(): number {
        return this.shortTerm.getMessages().filter(msg => msg.role === "user").length;
    }

    private compactIfNeeded(): void {
        const beforeCount = this.getMessages().length;
        const shortTermMessages = this.shortTerm.getMessages();
        const rawMessageCount = shortTermMessages.length + (this.systemMessage ? 1 : 0);
        const historyChars = this.estimateHistoryChars();
        const countExceeded = rawMessageCount > this.maxHistoryMessages;
        const charsExceeded = historyChars > this.maxHistoryChars;
        if (!countExceeded && !charsExceeded) return;

        let splitIndex = Math.max(0, shortTermMessages.length - this.keepRecentMessages);
        while (splitIndex > 0 && shortTermMessages[splitIndex]?.role === 'tool') {
            splitIndex--;
        }

        const recent = shortTermMessages.slice(splitIndex);
        const old = shortTermMessages.slice(0, splitIndex);
        if (old.length === 0) return;

        this.midTerm.mergeMessages(old);
        this.shortTerm.replace(recent);
        const afterMessages = this.getMessages();
        void getActiveSpan()?.addEvent('memory.compaction', {
            'wiki_agent.memory.before_count': beforeCount,
            'wiki_agent.memory.after_count': afterMessages.length,
            'wiki_agent.memory.summarized_count': old.length,
            'wiki_agent.memory.reason': countExceeded ? 'max_messages' : 'max_chars'
        });
        console.log("🧹 [MemoryManager] 历史上下文已自动压缩，保留近期关键消息。");
    }

    private estimateHistoryChars(): number {
        return estimateMessagesSize(this.getMessages()).chars;
    }
}

function summarizeMessage(msg: MemoryMessage): string {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    const toolCalls = 'tool_calls' in msg && msg.tool_calls ? ` tool_calls=${msg.tool_calls.filter(isFunctionToolCall).map(call => call.function.name).join(',')}` : '';
    return `role=${msg.role}${toolCalls} content=${content.replace(/\s+/g, ' ').slice(0, 240)}`;
}
