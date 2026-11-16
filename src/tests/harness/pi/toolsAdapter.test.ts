import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../../tools/registry.js';
import { collectPiToolNames, listWikiToolsForPi } from '../../../harness/pi/toolsAdapter.js';
import type { IAgentTool } from '../../../types.js';

function createStubTool(name: string): IAgentTool {
    return {
        name,
        permission: 'read',
        riskLevel: 'safe',
        isReadOnly: true,
        requiresApproval: false,
        schema: {
            type: 'function',
            function: {
                name,
                description: `stub ${name}`,
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' }
                    }
                }
            }
        },
        async execute() {
            return { status: 'success', data: { ok: true } };
        }
    };
}

test('listWikiToolsForPi mirrors registry schema filter', () => {
    const registry = new ToolRegistry();
    registry.register(createStubTool('alpha'));
    registry.register(createStubTool('beta'));
    registry.setSchemaFilter(tool => tool.name !== 'beta');

    const tools = listWikiToolsForPi(registry);
    assert.deepEqual(tools.map(tool => tool.name), ['alpha']);
    assert.deepEqual(collectPiToolNames(registry), ['alpha']);
});
