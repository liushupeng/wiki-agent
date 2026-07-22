import OpenAI from 'openai';
import { getActiveSpan } from '../trace/telemetry.js';
import { IMemory } from '../types.js';
import { estimateMessagesSize } from '../utils/tokenBudget.js';

type FunctionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
    type: 'function';
    function: { name: string };
};
type MemoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function isFunctionToolCall(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall): toolCall is FunctionToolCall {
    return toolCall.type === 'function' && 'function' in toolCall;
}

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
    private entries: string[] = [];

    mergeMessages(messages: MemoryMessage[]): void {
        this.entries.push(...messages.map(summarizeMessage));
    }

    toMessage(): MemoryMessage | undefined {
        if (this.entries.length === 0) return undefined;
        return {
            role: 'system',
            content: `以下是较早上下文的自动压缩摘要，用于保持任务连续性：\n${this.entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}`
        };
    }

    clear(): void {
        this.entries = [];
    }
}

class LongTermMemory {
    private items: string[] = [];

    toMessage(): MemoryMessage | undefined {
        if (this.items.length === 0) return undefined;
        return {
            role: 'system',
            content: `以下是长期记忆，用于保持跨任务连续性：\n${this.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
        };
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

    constructor(systemPrompt: string, options: { maxHistoryMessages?: number; keepRecentMessages?: number } = {}) {
        this.maxHistoryMessages = options.maxHistoryMessages ?? Number(process.env.MEMORY_MAX_MESSAGES ?? 40);
        this.keepRecentMessages = options.keepRecentMessages ?? Number(process.env.MEMORY_KEEP_RECENT_MESSAGES ?? 18);
        this.maxHistoryChars = Number(process.env.MEMORY_MAX_CHARS ?? 60000);
        if (systemPrompt.trim()) {
            this.systemMessage = { role: 'system', content: systemPrompt.trim() };
        }
    }

    getMessages(): MemoryMessage[] {
        return [
            ...(this.systemMessage ? [this.systemMessage] : []),
            ...[this.midTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...[this.longTerm.toMessage()].filter((message): message is MemoryMessage => Boolean(message)),
            ...this.shortTerm.getMessages()
        ];
    }

    append(message: MemoryMessage): void {
        const toolCalls = 'tool_calls' in message ? message.tool_calls : undefined;
        if (!message.content && (!toolCalls || toolCalls.length === 0)) return;
        this.shortTerm.append(message);
        this.compactIfNeeded();
    }

    clear(): void {
        this.shortTerm.clear();
        this.midTerm.clear();
        this.longTerm.clear();
        console.log('🧹 [MemoryManager] 滚动区历史已被安全释放，已恢复初始 System 设定。');
    }

    getRoundCount(): number {
        return this.shortTerm.getMessages().filter(msg => msg.role === 'user').length;
    }

    private compactIfNeeded(): void {
        const beforeCount = this.getMessages().length;
        const shortTermMessages = this.shortTerm.getMessages();
        const rawMessageCount = shortTermMessages.length + (this.systemMessage ? 1 : 0);
        const historyChars = estimateMessagesSize(this.getMessages()).chars;
        const countExceeded = rawMessageCount > this.maxHistoryMessages;
        const charsExceeded = historyChars > this.maxHistoryChars;
        if (!countExceeded && !charsExceeded) return;

        let splitIndex = Math.max(0, shortTermMessages.length - this.keepRecentMessages);
        while (splitIndex > 0 && shortTermMessages[splitIndex]?.role === 'tool') splitIndex--;
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
        console.log('🧹 [MemoryManager] 历史上下文已自动压缩，保留近期关键消息。');
    }
}

function summarizeMessage(message: MemoryMessage): string {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    const toolCalls = 'tool_calls' in message && message.tool_calls
        ? ` tool_calls=${message.tool_calls.filter(isFunctionToolCall).map(call => call.function.name).join(',')}`
        : '';
    return `role=${message.role}${toolCalls} content=${content.replace(/\s+/g, ' ').slice(0, 240)}`;
}
