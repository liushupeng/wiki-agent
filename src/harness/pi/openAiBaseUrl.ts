/**
 * Pi 的 openai-completions 适配器与 OpenAI SDK 一样，期望 baseURL 以 `/v1` 结尾。
 */
export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/$/, '');
    if (trimmed.endsWith('/v1')) return trimmed;
    return `${trimmed}/v1`;
}

export function isDeepSeekCompatibleHost(baseUrl: string): boolean {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
    } catch {
        return false;
    }
}
