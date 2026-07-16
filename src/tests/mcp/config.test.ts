import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMcpServerConfigs } from '../../mcp/config.js';

test('loadMcpServerConfigs returns an empty list when MCP config path is not configured', async () => {
    assert.deepEqual(await loadMcpServerConfigs({}), []);
});

test('loadMcpServerConfigs parses enabled stdio server configs from a JSONC file', async () => {
    await withMcpConfig([{
        name: 'sqlite',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', 'memory.db'],
        toolNamePrefix: 'mcp_sqlite',
        defaultPermission: 'mcp',
        defaultRiskLevel: 'write'
    }], async configPath => {
        const configs = await loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath });

        assert.deepEqual(configs, [{
            name: 'sqlite',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sqlite', 'memory.db'],
            toolNamePrefix: 'mcp_sqlite',
            defaultPermission: 'mcp',
            defaultRiskLevel: 'write',
            enabled: true
        }]);
    });
});

test('loadMcpServerConfigs accepts JSONC comments and trailing commas', async () => {
    await withRawMcpConfig(`{
        // Servers can be documented inline.
        "servers": [{
            "name": "git",
            "command": "mcp-server-git",
            "args": ["--repository", ".",],
        },],
    }`, async configPath => {
        const configs = await loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath });
        assert.equal(configs[0]?.name, 'git');
        assert.deepEqual(configs[0]?.args, ['--repository', '.']);
    });
});

test('loadMcpServerConfigs skips disabled server configs', async () => {
    await withMcpConfig([{ name: 'git', command: 'npx', enabled: false }], async configPath => {
        const configs = await loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath });
        assert.deepEqual(configs, []);
    });
});

test('loadMcpServerConfigs rejects invalid JSON and invalid shapes', async () => {
    await withRawMcpConfig('{bad', async configPath => {
        await assert.rejects(() => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath }), /invalid MCP config file/);
    });
    await withMcpConfig({}, async configPath => {
        await assert.rejects(() => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath }), /expected a "servers" array/);
    });
    await withRawMcpConfig(JSON.stringify([{ name: 'git', command: 'git-mcp' }]), async configPath => {
        await assert.rejects(() => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath }), /expected a "servers" array/);
    });
    await withMcpConfig([{ name: 'fs' }], async configPath => {
        await assert.rejects(() => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath }), /command must be/);
    });
});

async function withMcpConfig(value: unknown, run: (configPath: string) => Promise<void>): Promise<void> {
    await withRawMcpConfig(JSON.stringify({ servers: value }), run);
}

async function withRawMcpConfig(content: string, run: (configPath: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-mcp-config-'));
    const configPath = path.join(dir, 'mcp.servers.jsonc');
    await fs.writeFile(configPath, content, 'utf-8');

    try {
        await run(configPath);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
