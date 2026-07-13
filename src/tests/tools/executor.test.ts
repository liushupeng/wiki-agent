import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionPolicy } from '../../permissions.js';
import { BaseAgentTool } from '../../tools/base.js';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import { ToolResult } from '../../types.js';
import { SafeTool, WriteTool } from '../helpers.js';

class ValidatedTool extends BaseAgentTool {
    readonly name = 'validated_tool';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'validated_tool',
            description: 'test tool with validation',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const value = (args as { value?: unknown }).value;
        return typeof value === 'string' ? [] : ['value must be a string'];
    }

    async execute(args: unknown): Promise<ToolResult> {
        return this.ok(args);
    }
}

test('ToolExecutor executes allowed tools', async () => {
    const registry = new ToolRegistry();
    registry.register(new SafeTool());
    const executor = new ToolExecutor(registry, new PermissionPolicy('prompt'));

    const result = await executor.execute('safe_tool', '{}');

    assert.equal(result.status, 'success');
});

test('ToolExecutor returns invalid_args for invalid JSON before execution', async () => {
    const registry = new ToolRegistry();
    registry.register(new SafeTool());
    const executor = new ToolExecutor(registry, new PermissionPolicy('auto'));

    const result = await executor.execute('safe_tool', '{invalid');

    assert.equal(result.status, 'invalid_args');
});

test('ToolExecutor returns validation errors before permission checks', async () => {
    const registry = new ToolRegistry();
    registry.register(new ValidatedTool());
    const executor = new ToolExecutor(registry, new PermissionPolicy('auto'));

    const result = await executor.execute('validated_tool', '{}');

    assert.equal(result.status, 'invalid_args');
    assert.match(result.error ?? '', /value must be a string/);
});

test('ToolExecutor asks for approval and returns approval_denied when rejected', async () => {
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    const executor = new ToolExecutor(registry, new PermissionPolicy('prompt'), async request => {
        assert.equal(request.toolName, 'write_tool');
        assert.equal(request.riskLevel, 'write');
        return false;
    });

    const result = await executor.execute('write_tool', '{}');

    assert.equal(result.status, 'approval_denied');
});

test('ToolExecutor converts missing tools to runtime_error observations', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry, new PermissionPolicy('auto'));

    const result = await executor.execute('missing_tool', '{}');

    assert.equal(result.status, 'runtime_error');
    assert.match(result.error ?? '', /未找到工具/);
});
