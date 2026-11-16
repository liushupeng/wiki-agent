import path from 'node:path';
import { ModelRuntime, type ProviderConfig } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { isDeepSeekCompatibleHost, normalizeOpenAiCompatibleBaseUrl } from './openAiBaseUrl.js';

export const WIKI_PI_PROVIDER_ID = 'wiki-openai-compatible';

export type WikiPiModelBinding = {
    runtime: ModelRuntime;
    model: Model<Api>;
    agentDir: string;
};

export async function createWikiPiModelBinding(modelName: string): Promise<WikiPiModelBinding> {
    const baseUrl = process.env.BASE_URL?.trim();
    const apiKey = process.env.API_KEY?.trim();
    if (!baseUrl) throw new Error('Pi harness 需要配置 BASE_URL');
    if (!apiKey) throw new Error('Pi harness 需要配置 API_KEY');

    const agentDir = path.resolve(process.env.PI_AGENT_DIR ?? path.join('var', 'pi-agent'));
    const runtime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false
    });

    const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(baseUrl);
    const deepseek = isDeepSeekCompatibleHost(baseUrl);

    const providerConfig: ProviderConfig = {
        name: 'Wiki OpenAI Compatible',
        baseUrl: normalizedBaseUrl,
        apiKey,
        api: 'openai-completions',
        models: [{
            id: modelName,
            name: modelName,
            reasoning: deepseek,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8192,
            ...(deepseek ? {
                compat: {
                    supportsReasoningEffort: true,
                    supportsUsageInStreaming: true,
                    thinkingFormat: 'deepseek'
                }
            } : {})
        }]
    };
    runtime.registerProvider(WIKI_PI_PROVIDER_ID, providerConfig);
    await runtime.setRuntimeApiKey(WIKI_PI_PROVIDER_ID, apiKey);

    const model = runtime.getModel(WIKI_PI_PROVIDER_ID, modelName);
    if (!model) {
        throw new Error(`Pi harness 无法解析模型：${WIKI_PI_PROVIDER_ID}/${modelName}`);
    }
    return { runtime, model, agentDir };
}
