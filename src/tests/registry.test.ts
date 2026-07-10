import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../tools/registry.js';
import { SafeTool } from './helpers.js';

class ValidatedTool extends SafeTool {
    readonly name = 'validated_tool';

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const value = (args as { value?: unknown }).value;
        return typeof value === 'string' ? [] : ['value must be a string'];
    }
}

test('ToolRegistry registers tools and exposes schemas', () => {
    const registry = new ToolRegistry();
    registry.register(new SafeTool());

    const schema = registry.getSchemas()[0];
    assert.equal(registry.has('safe_tool'), true);
    assert.equal(registry.getTool('safe_tool')?.name, 'safe_tool');
    assert.equal(schema.type, 'function');
    if (schema.type === 'function') {
        assert.equal(schema.function.name, 'safe_tool');
    }
});

test('ToolRegistry rejects invalid JSON arguments', async () => {
    const registry = new ToolRegistry();
    registry.register(new SafeTool());

    const result = await registry.execute('safe_tool', '{invalid');

    assert.equal(result.status, 'invalid_args');
});

test('ToolRegistry validates tool arguments before execution', async () => {
    const registry = new ToolRegistry();
    registry.register(new ValidatedTool());

    const result = await registry.execute('validated_tool', '{}');

    assert.equal(result.status, 'invalid_args');
    assert.match(result.error ?? '', /value must be a string/);
});
