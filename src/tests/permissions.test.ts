import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionPolicy } from '../permissions.js';
import { SafeTool, ShellTool, WriteTool } from './helpers.js';
import { RunTestsTool } from '../tools/codingTool.js';

class DangerousTool extends SafeTool {
    readonly name = 'dangerous_tool';
    readonly riskLevel = 'dangerous' as const;
}

class NetworkTool extends SafeTool {
    readonly name = 'network_tool';
    readonly riskLevel = 'network' as const;
}

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

test('PermissionPolicy rejects tools marked as dangerous', () => {
    const decision = new PermissionPolicy('auto').evaluate(new DangerousTool(), {});

    assert.equal(decision.action, 'deny');
    assert.match(decision.reason, /dangerous/);
});

test('PermissionPolicy denies approval-required tools in deny mode', () => {
    const decision = new PermissionPolicy('deny').evaluate(new WriteTool(), {});

    assert.equal(decision.action, 'deny');
    assert.match(decision.reason, /approval mode is deny/);
});

test('PermissionPolicy requires explicit approval for risky tools in auto mode', () => {
    const decision = new PermissionPolicy('auto').evaluate(new NetworkTool(), {});

    assert.equal(decision.action, 'ask');
    assert.match(decision.reason, /explicit user approval/);
});

test('PermissionPolicy rejects empty shell commands', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new ShellTool(), { command: '   ' });

    assert.equal(decision.action, 'deny');
    assert.match(decision.reason, /empty/);
});

test('PermissionPolicy rejects shell executables outside the allowlist', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new ShellTool(), { command: 'python script.py' });

    assert.equal(decision.action, 'deny');
    assert.match(decision.reason, /not allowlisted/);
});

test('PermissionPolicy asks before allowlisted shell commands in prompt mode', () => {
    const decision = new PermissionPolicy('prompt').evaluate(new ShellTool(), { command: 'npm test' });

    assert.equal(decision.action, 'ask');
    assert.match(decision.reason, /approval required for shell tool/);
});

test('PermissionPolicy resolves the default run_tests script before shell validation', () => {
    const decision = new PermissionPolicy('auto').evaluate(new RunTestsTool(), {});

    assert.equal(decision.action, 'ask');
    assert.doesNotMatch(decision.reason, /empty/);
});

test('PermissionPolicy never auto-approves compound allowlisted shell commands', () => {
    const decision = new PermissionPolicy('auto').evaluate(
        new ShellTool(),
        { command: 'git status & node -e "console.log(1)"' }
    );

    assert.equal(decision.action, 'ask');
});
