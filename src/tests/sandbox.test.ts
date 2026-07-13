import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSandboxRoot, resolveSafePath, toSandboxRelativePath } from '../sandbox.js';

test('resolveSafePath rejects traversal outside sandbox', () => {
    assert.throws(() => resolveSafePath('..\\outside.txt'), /不在安全沙盒内/);
});

test('sandbox helpers read AGENT_SANDBOX_ROOT at runtime', () => {
    const previousRoot = process.env.AGENT_SANDBOX_ROOT;
    const tempRoot = path.join(os.tmpdir(), 'wiki-agent-sandbox-runtime');
    process.env.AGENT_SANDBOX_ROOT = tempRoot;

    try {
        assert.equal(getSandboxRoot(), path.resolve(tempRoot));
        assert.equal(resolveSafePath('notes/a.md'), path.join(path.resolve(tempRoot), 'notes', 'a.md'));
        assert.equal(toSandboxRelativePath(path.join(path.resolve(tempRoot), 'notes', 'a.md')), 'notes/a.md');
    } finally {
        if (previousRoot === undefined) {
            delete process.env.AGENT_SANDBOX_ROOT;
        } else {
            process.env.AGENT_SANDBOX_ROOT = previousRoot;
        }
    }
});
