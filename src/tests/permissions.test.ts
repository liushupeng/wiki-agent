import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionPolicy } from '../permissions.js';
import { SafeTool, ShellTool, WriteTool } from './helpers.js';

test('PermissionPolicy allows safe read-only tools', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new SafeTool(), {});

    assert.equal(decision.action, 'allow');
});

test('PermissionPolicy asks before write tools in prompt mode', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new WriteTool(), {});

    assert.equal(decision.action, 'ask');
});

test('PermissionPolicy rejects dangerous shell tokens', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new ShellTool(), { command: 'rm -rf .' });

    assert.equal(decision.action, 'deny');
});
