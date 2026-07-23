import '../src/env.js';
import { loadMcpServerConfigs } from '../src/mcp/config.js';
import { loadRagIndexesConfig, resolveRagIndexProfile } from '../src/rag/indexProfiles.js';
import { getKnowledgeSourceRoots } from '../src/rag/sourceRoots.js';

async function main() {
    const errors: string[] = [];
    validateLlmEnvironment(errors);

    const [sourceRoots, ragConfig] = await Promise.all([
        getKnowledgeSourceRoots(),
        loadRagIndexesConfig()
    ]);
    const activeProfile = resolveRagIndexProfile(ragConfig);
    validateEmbeddingEnvironment(activeProfile.embedder, errors);

    const mcpConfigs = await loadMcpServerConfigs();
    if (errors.length > 0) {
        throw new Error(`configuration check failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
    }

    console.log('Configuration check passed');
    console.log(`  LLM model:       ${process.env.MODEL_NAME}`);
    console.log(`  Knowledge roots: ${sourceRoots.map(root => root.prefix).join(', ')}`);
    console.log(`  Active profile:  ${activeProfile.id}`);
    console.log(`  MCP servers:     ${mcpConfigs.filter(config => config.enabled !== false).length}`);
}

function validateLlmEnvironment(errors: string[]): void {
    const baseUrl = process.env.BASE_URL?.trim();
    if (!baseUrl) {
        errors.push('missing BASE_URL');
    } else {
        try {
            new URL(baseUrl);
        } catch {
            errors.push(`invalid BASE_URL: ${baseUrl}`);
        }
    }
    if (!process.env.MODEL_NAME?.trim()) errors.push('missing MODEL_NAME');
    if (isMissingSecret(process.env.API_KEY)) errors.push('missing API_KEY (set it in .env or the process environment)');
}

function validateEmbeddingEnvironment(
    embedder: Awaited<ReturnType<typeof resolveRagIndexProfile>>['embedder'],
    errors: string[]
): void {
    if (embedder.type !== 'openai-compatible') return;
    if (isMissingSecret(process.env[embedder.apiKeyEnv])) {
        errors.push(`missing ${embedder.apiKeyEnv} required by active profile ${embedder.model}`);
    }
    if (!process.env[embedder.baseUrlEnv]?.trim()) {
        errors.push(`missing ${embedder.baseUrlEnv} required by active profile ${embedder.model}`);
    }
}

function isMissingSecret(value: string | undefined): boolean {
    return !value?.trim() || /^your_(real_)?api_key$/i.test(value.trim());
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
