export type LimitedText = {
    text: string;
    truncated: boolean;
    originalLength: number;
    maxLength: number;
};

export function limitText(value: string, maxLength = Number(process.env.TOOL_OUTPUT_MAX_CHARS ?? 12000)): LimitedText {
    if (value.length <= maxLength) {
        return {
            text: value,
            truncated: false,
            originalLength: value.length,
            maxLength
        };
    }

    return {
        text: `${value.slice(0, maxLength)}\n\n[output truncated: ${value.length - maxLength} characters omitted]`,
        truncated: true,
        originalLength: value.length,
        maxLength
    };
}

export function getMaxFileBytes(): number {
    return Number(process.env.READ_FILE_MAX_BYTES ?? 200000);
}
