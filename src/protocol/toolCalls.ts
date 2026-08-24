import OpenAI from 'openai';

export type FunctionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

export type ToolExecutionResult = {
    toolMessage: OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    originalIndex: number;
};

type ToolCallBuffer = Array<{
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
} | undefined>;

export function isFunctionToolCall(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall): toolCall is FunctionToolCall {
    return toolCall.type === "function" && "function" in toolCall;
}

export function appendToolCallDeltas(
    buffer: ToolCallBuffer,
    toolCallDeltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
): void {
    for (const toolCallDelta of toolCallDeltas) {
        const index = toolCallDelta.index;
        if (!buffer[index]) {
            buffer[index] = {
                id: toolCallDelta.id || "",
                type: "function",
                function: { name: toolCallDelta.function?.name || "", arguments: "" }
            };
        }

        if (toolCallDelta.id && !buffer[index].id) {
            buffer[index].id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name && !buffer[index].function.name) {
            buffer[index].function.name = toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
            buffer[index].function.arguments += toolCallDelta.function.arguments;
        }
    }
}

export function buildToolCalls(buffer: ToolCallBuffer): FunctionToolCall[] {
    return buffer.filter(Boolean) as FunctionToolCall[];
}

export function buildSkippedToolResult(toolCall: { id: string; type: string }, originalIndex: number): ToolExecutionResult {
    return {
        originalIndex,
        toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ status: "error", error: "unsupported_tool_call_type", metadata: { type: toolCall.type } })
        }
    };
}
