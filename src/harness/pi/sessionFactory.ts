import path from 'node:path';
import {
    AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager
} from '@earendil-works/pi-coding-agent';
import type { AgentConfig, IMemory, IToolRegistry } from '../../types.js';
import { createWikiPiModelBinding } from './modelRuntime.js';
import { createWikiEvidencePiExtension } from './evidenceExtension.js';
import { buildPiCustomTools, collectPiToolNames } from './toolsAdapter.js';
import type { PiToolRuntimeContext } from './toolsAdapter.js';

export type WikiPiSessionBundle = {
    session: AgentSession;
    dispose: () => void;
};

export async function createWikiPiSession(
    config: AgentConfig,
    memory: IMemory,
    registry: IToolRegistry,
    toolRuntime: PiToolRuntimeContext
): Promise<WikiPiSessionBundle> {
    const systemPrompt = extractSystemPrompt(memory);
    if (!systemPrompt) throw new Error('Pi harness 需要 Memory 中的 system prompt');

    const { runtime, model, agentDir } = await createWikiPiModelBinding(config.modelName);
    const settingsManager = SettingsManager.create(process.cwd(), agentDir);
    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
        settingsManager,
        systemPrompt,
        noExtensions: true,
        extensionFactories: [
            createWikiEvidencePiExtension({
                registry,
                evidencePolicy: toolRuntime.evidencePolicy
            })
        ],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true
    });
    await resourceLoader.reload();

    const customTools = buildPiCustomTools(registry, toolRuntime);
    const toolNames = collectPiToolNames(registry);

    const { session } = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: 'high',
        noTools: 'all',
        tools: toolNames,
        customTools,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager
    });

    return {
        session,
        dispose: () => {
            session.dispose();
        }
    };
}

function extractSystemPrompt(memory: IMemory): string | undefined {
    const system = memory.getMessages().find(message => message.role === 'system');
    if (!system || system.role !== 'system') return undefined;
    return typeof system.content === 'string' ? system.content : undefined;
}
