import type { AgentSession } from '@earendil-works/pi-coding-agent';

type AssistantErrorMessage = {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
};

export function readPiSessionFailure(session: AgentSession): string | undefined {
    const messages = session.messages as AssistantErrorMessage[];
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        if (message.errorMessage?.trim()) return message.errorMessage.trim();
        if (message.stopReason === 'error') {
            return '模型返回 stopReason=error，但未提供 errorMessage';
        }
    }
    return undefined;
}

export function readPiAssistantText(session: AgentSession): string {
    const fromApi = session.getLastAssistantText()?.trim();
    if (fromApi) return fromApi;
    return extractAssistantTextFromMessages(session.messages as { role?: string; content?: unknown }[]);
}

function extractAssistantTextFromMessages(messages: { role?: string; content?: unknown }[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        const text = assistantMessageToText(message);
        if (text.trim()) return text;
    }
    return '';
}

function assistantMessageToText(message: { content?: unknown }): string {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content
        .filter(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text')
        .map(block => (block as { text?: string }).text ?? '')
        .join('');
}
