import assert from 'node:assert/strict';
import test from 'node:test';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpServerConfig } from '../../mcp/config.js';
import { McpCallToolResult, McpClientLike } from '../../mcp/client.js';
import { buildMcpToolName, McpAgentTool } from '../../mcp/toolAdapter.js';

const serverConfig: McpServerConfig = {
    name: 'filesystem',
    command: 'npx',
    args: [],
    toolNamePrefix: 'mcp_fs',
    defaultPermission: 'mcp',
    defaultRiskLevel: 'write',
    enabled: true
};

test('buildMcpToolName sanitizes remote tool names', () => {
    assert.equal(buildMcpToolName('mcp fs', 'read/file'), 'mcp_fs_read_file');
});

test('McpAgentTool exposes MCP tools as OpenAI function tools', () => {
    const tool = new McpAgentTool(fakeClient({ content: [] }), serverConfig, remoteTool({
        name: 'read_file',
        description: 'Read a file',
        annotations: { readOnlyHint: true }
    }));

    assert.equal(tool.name, 'mcp_fs_read_file');
    assert.equal(tool.permission, 'mcp');
    assert.equal(tool.riskLevel, 'safe');
    assert.equal(tool.isReadOnly, true);
    assert.equal(tool.requiresApproval, false);
    assert.equal(tool.schema.type, 'function');
    assert.equal(tool.schema.function.name, 'mcp_fs_read_file');
    assert.match(tool.schema.function.description ?? '', /\[MCP:filesystem\]/);
});

test('McpAgentTool infers destructive and open-world risk hints', () => {
    const writeTool = new McpAgentTool(fakeClient({ content: [] }), serverConfig, remoteTool({
        name: 'write_file',
        annotations: { destructiveHint: true }
    }));
    const networkTool = new McpAgentTool(fakeClient({ content: [] }), serverConfig, remoteTool({
        name: 'fetch',
        annotations: { openWorldHint: true }
    }));

    assert.equal(writeTool.permission, 'write');
    assert.equal(writeTool.riskLevel, 'write');
    assert.equal(writeTool.requiresApproval, true);
    assert.equal(networkTool.permission, 'mcp');
    assert.equal(networkTool.riskLevel, 'network');
});

test('McpAgentTool validates object arguments and calls the remote MCP tool', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const tool = new McpAgentTool(fakeClient({
        content: [{ type: 'text', text: 'hello from MCP' }]
    }, calls), serverConfig, remoteTool({ name: 'echo' }));

    assert.deepEqual(tool.validateArgs('bad'), ['MCP tool arguments must be an object']);

    const result = await tool.execute({ value: 'ok' });

    assert.equal(result.status, 'success');
    assert.deepEqual(calls, [{ name: 'echo', arguments: { value: 'ok' } }]);
    assert.match((result.data as { content: string }).content, /hello from MCP/);
    assert.equal(result.metadata?.mcpServer, 'filesystem');
});

test('McpAgentTool converts MCP tool errors to execution_failed results', async () => {
    const tool = new McpAgentTool(fakeClient({
        content: [{ type: 'text', text: 'remote failure' }],
        isError: true
    }), serverConfig, remoteTool({ name: 'fail' }));

    const result = await tool.execute({});

    assert.equal(result.status, 'execution_failed');
    assert.match(result.error ?? '', /remote failure/);
    assert.equal(result.metadata?.isError, true);
});

function remoteTool(input: Partial<Tool>): Tool {
    return {
        name: input.name ?? 'tool',
        description: input.description,
        annotations: input.annotations,
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    };
}

function fakeClient(
    result: McpCallToolResult,
    calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
): McpClientLike {
    return {
        async listTools() {
            return { tools: [] };
        },
        async callTool(params) {
            calls.push(params);
            return result;
        }
    };
}
