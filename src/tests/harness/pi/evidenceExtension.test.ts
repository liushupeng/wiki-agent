import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeEvidencePolicy } from '../../../context/runtimeEvidencePolicy.js';
import { ToolRegistry } from '../../../tools/registry.js';
import { listEligibleWikiToolNames } from '../../../harness/pi/evidenceExtension.js';
import type { IAgentTool } from '../../../types.js';

function stubTool(name: string, permission: IAgentTool['permission']): IAgentTool {
    return {
        name,
        permission,
        riskLevel: 'safe',
        isReadOnly: permission === 'read' || permission === 'rag',
        requiresApproval: false,
        schema: {
            type: 'function',
            function: {
                name,
                description: name,
                parameters: { type: 'object', properties: {} }
            }
        },
        async execute() {
            return { status: 'success', data: {} };
        }
    };
}

test('listEligibleWikiToolNames drops RAG tools when runtime budget is exhausted', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('read_file', 'read'));
    registry.register(stubTool('search_notes', 'rag'));
    registry.register(stubTool('grep_notes', 'rag'));

    const policy = new RuntimeEvidencePolicy(1);
    assert.deepEqual(listEligibleWikiToolNames(registry, policy), ['read_file', 'search_notes', 'grep_notes']);

    policy.recordRagCall();
    assert.deepEqual(listEligibleWikiToolNames(registry, policy), ['read_file']);
});

test('listEligibleWikiToolNames respects registry schema filter', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('alpha', 'read'));
    registry.register(stubTool('search_notes', 'rag'));
    registry.setSchemaFilter(tool => tool.name !== 'search_notes');

    const policy = new RuntimeEvidencePolicy(3);
    assert.deepEqual(listEligibleWikiToolNames(registry, policy), ['alpha']);
});
