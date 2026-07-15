import OpenAI from 'openai';

export type SizeEstimate = {
    chars: number;
    approxTokens: number;
};

/**
 * 轻量 token 估算。
 *
 * 这里不引入 tokenizer，也不做模型价格计算；先用 chars / 4 近似估算，
 * 足够用于定位哪类上下文最占空间。后续如果需要精确计费，可以在这里替换实现。
 */
export function estimateTextSize(value: string): SizeEstimate {
    return {
        chars: value.length,
        approxTokens: Math.ceil(value.length / 4)
    };
}

export function estimateJsonSize(value: unknown): SizeEstimate {
    return estimateTextSize(JSON.stringify(value ?? ''));
}

export function estimateMessagesSize(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): SizeEstimate {
    return estimateJsonSize(messages);
}

export function estimateToolSchemasSize(toolSchemas: OpenAI.Chat.Completions.ChatCompletionTool[]): SizeEstimate {
    return estimateJsonSize(toolSchemas);
}
