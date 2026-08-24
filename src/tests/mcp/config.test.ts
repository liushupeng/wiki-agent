import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMcpServerConfigs } from '../../mcp/config.js';
import { shouldRegisterMcpTool } from '../../mcp/register.js';

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
            disabledTools: [],
            defaultPermission: 'mcp',
            defaultRiskLevel: 'write',
            enabled: true
        }]);
    });
});

test('loadMcpServerConfigs reads disabled MCP tool names', async () => {
    await withMcpConfig([{
        name: 'filesystem',
        command: 'mcp-server-filesystem',
        disabledTools: ['write_file', 'write_file']
    }], async configPath => {
        const [config] = await loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath });
        assert.deepEqual(config?.disabledTools, ['write_file']);
    });
});

test('disabled MCP tools are not registered into the Agent registry', () => {
    assert.equal(shouldRegisterMcpTool({ disabledTools: ['write_file'] }, 'write_file'), false);
    assert.equal(shouldRegisterMcpTool({ disabledTools: ['write_file'] }, 'read_file'), true);
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
    await withMcpConfig([{ name: 'fs', command: 'mcp-server-filesystem', disabledTools: [''] }], async configPath => {
        await assert.rejects(() => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath }), /disabledTools must be/);
    });
});

test('loadMcpServerConfigs rejects MCP access to the MemoryStore database', async () => {
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-memory-db-'));
    try {
        await withMcpConfig([{
            name: 'sqlite',
            command: 'mcp-server-sqlite',
            args: ['--db-path', path.join(memoryDir, 'agent.db')]
        }], async configPath => {
            await assert.rejects(
                () => loadMcpServerConfigs({ MCP_CONFIG_PATH: configPath, MEMORY_DIR: memoryDir }),
                /must not use the MemoryStore database/
            );
        });
    } finally {
        await fs.rm(memoryDir, { recursive: true, force: true });
    }
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
