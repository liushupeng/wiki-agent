import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWriteScopes, resolveWriteScopePath } from '../../config/writeScopes.js';

test('loadWriteScopes reads named scopes and validates roots against the workspace', async () => {
    await withWorkspace(async (workspace, configPath) => {
        await fs.writeFile(configPath, `{
            "defaultScope": "sandbox",
            "scopes": [
                { "name": "sandbox", "root": "var/sandbox", "description": "default" },
                { "name": "wiki", "root": "wiki", "description": "wiki pages" }
            ]
        }`);

        const config = await loadWriteScopes({ WRITE_SCOPES_CONFIG_PATH: configPath });

        assert.equal(config.defaultScope, 'sandbox');
        assert.deepEqual(config.scopes.map(scope => scope.name), ['sandbox', 'wiki']);
        assert.equal(
            await resolveWriteScopePath(config.scopes[1]!, 'concepts/rag.md'),
            path.join(workspace, 'wiki', 'concepts', 'rag.md')
        );
    });
});

test('loadWriteScopes rejects unknown defaults, duplicate names, and roots outside the workspace', async () => {
    await withWorkspace(async (_workspace, configPath) => {
        await fs.writeFile(configPath, `{
            "defaultScope": "unknown",
            "scopes": [{ "name": "sandbox", "root": "var/sandbox", "description": "default" }]
        }`);
        await assert.rejects(() => loadWriteScopes({ WRITE_SCOPES_CONFIG_PATH: configPath }), /not declared/);

        await fs.writeFile(configPath, `{
            "defaultScope": "sandbox",
            "scopes": [
                { "name": "sandbox", "root": "var/sandbox", "description": "default" },
                { "name": "sandbox", "root": "wiki", "description": "duplicate" }
            ]
        }`);
        await assert.rejects(() => loadWriteScopes({ WRITE_SCOPES_CONFIG_PATH: configPath }), /duplicate scope/);

        await fs.writeFile(configPath, `{
            "defaultScope": "sandbox",
            "scopes": [{ "name": "sandbox", "root": "../outside", "description": "invalid" }]
        }`);
        await assert.rejects(() => loadWriteScopes({ WRITE_SCOPES_CONFIG_PATH: configPath }), /outside the workspace boundary/);
    });
});

test('resolveWriteScopePath rejects path traversal and symbolic-link escapes', async t => {
    await withWorkspace(async (workspace, configPath) => {
        await fs.writeFile(configPath, `{
            "defaultScope": "sandbox",
            "scopes": [{ "name": "sandbox", "root": "var/sandbox", "description": "default" }]
        }`);
        const [scope] = (await loadWriteScopes({ WRITE_SCOPES_CONFIG_PATH: configPath })).scopes;
        assert.ok(scope);

        await assert.rejects(() => resolveWriteScopePath(scope, '../outside.txt'), /outside the workspace boundary/);

        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-write-scope-outside-'));
        try {
            const scopeRoot = path.join(workspace, 'var', 'sandbox');
            await fs.mkdir(scopeRoot, { recursive: true });
            try {
                await fs.symlink(outside, path.join(scopeRoot, 'escape'), 'junction');
            } catch (error: any) {
                if (error.code === 'EPERM' || error.code === 'EACCES') {
                    t.skip('symbolic links are unavailable in this Windows environment');
                    return;
                }
                throw error;
            }
            await assert.rejects(() => resolveWriteScopePath(scope, 'escape/outside.txt'), /outside the workspace boundary/);
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });
});

async function withWorkspace(run: (workspace: string, configPath: string) => Promise<void>): Promise<void> {
    const previousWorkspace = process.env.AGENT_WORKSPACE_ROOT;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-write-scopes-'));
    const configPath = path.join(workspace, 'write.scopes.jsonc');
    process.env.AGENT_WORKSPACE_ROOT = workspace;

    try {
        await run(workspace, configPath);
    } finally {
        restoreEnv('AGENT_WORKSPACE_ROOT', previousWorkspace);
        await fs.rm(workspace, { recursive: true, force: true });
    }
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
