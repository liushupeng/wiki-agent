import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { RuntimeEvidencePolicy } from '../../context/runtimeEvidencePolicy.js';
import type { IToolRegistry } from '../../types.js';
import { listWikiToolsForPi } from './toolsAdapter.js';

export type WikiPiEvidenceContext = {
    registry: IToolRegistry;
    evidencePolicy: RuntimeEvidencePolicy;
};

export function listEligibleWikiToolNames(
    registry: IToolRegistry,
    evidencePolicy: RuntimeEvidencePolicy
): string[] {
    return listWikiToolsForPi(registry)
        .filter(tool => tool.permission !== 'rag' || evidencePolicy.canCallRag())
        .map(tool => tool.name);
}

export function syncWikiEvidenceToolExposure(
    registry: IToolRegistry,
    evidencePolicy: RuntimeEvidencePolicy,
    session: Pick<AgentSession, 'setActiveToolsByName'>
): string[] {
    const names = listEligibleWikiToolNames(registry, evidencePolicy);
    session.setActiveToolsByName(names);
    return names;
}

/**
 * Pi inline extension: before each provider request, hide RAG tools when the runtime budget is exhausted.
 * Mirrors native `NativeAgent.callModel()` schema filtering.
 */
export function createWikiEvidencePiExtension(context: WikiPiEvidenceContext): InlineExtension {
    const apply = (pi: ExtensionAPI) => {
        pi.setActiveTools(listEligibleWikiToolNames(context.registry, context.evidencePolicy));
    };

    return {
        name: 'wiki-evidence',
        hidden: true,
        factory(pi) {
            pi.on('session_start', () => {
                apply(pi);
            });
            pi.on('context_with_system', () => {
                apply(pi);
            });
            pi.on('tool_execution_end', event => {
                const permission = context.registry.getTool(event.toolName)?.permission;
                if (permission === 'rag') {
                    apply(pi);
                }
            });
        }
    };
}