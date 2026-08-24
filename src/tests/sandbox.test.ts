import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSandboxRoot, resolveSafeExistingPath, resolveSafePath, toSandboxRelativePath } from '../sandbox.js';

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

test('resolveSafeExistingPath rejects symbolic-link escapes', async t => {
    const previousRoot = process.env.AGENT_SANDBOX_ROOT;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-sandbox-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-sandbox-outside-'));
    process.env.AGENT_SANDBOX_ROOT = root;
    try {
        await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf-8');
        try {
            await fs.symlink(outside, path.join(root, 'escape'), 'junction');
        } catch (error: any) {
            if (error.code === 'EPERM' || error.code === 'EACCES') {
                t.skip('symbolic links are unavailable in this Windows environment');
                return;
            }
            throw error;
        }
        await assert.rejects(() => resolveSafeExistingPath('escape/secret.txt'), /符号链接/);
    } finally {
        if (previousRoot === undefined) delete process.env.AGENT_SANDBOX_ROOT;
        else process.env.AGENT_SANDBOX_ROOT = previousRoot;
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    }
});
