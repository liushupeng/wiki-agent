import '../../src/env.js';
import { loadMcpServerConfigs } from '../../src/mcp/config.js';
import { StdioMcpClient } from '../../src/mcp/client.js';

/**
 * MCP server 连通性检查入口。
 *
 * 用法：
 * - npm run mcp:check
 *
 * 这个脚本会读取 MCP_CONFIG_PATH 指向的配置文件，只检查 enabled=true 的 server。
 * 每个 server 会执行 connect + listTools，用来验证外部 MCP 进程是否能启动、协议握手是否成功、
 * 以及当前暴露了哪些工具。
 */
async function main() {
    const configs = await loadMcpServerConfigs();
    if (configs.length === 0) {
        console.log('No enabled MCP servers. Set MCP_CONFIG_PATH and enable servers in the config file.');
        return;
    }

    let failedCount = 0;
    for (const config of configs) {
        const client = new StdioMcpClient(config, 'inherit');
        try {
            console.log(`\n[MCP] Checking ${config.name}...`);
            await client.connect();
            const { tools } = await client.listTools();
            console.log(`[MCP] ${config.name}: connected, ${tools.length} tools`);
            for (const tool of tools) {
                console.log(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
            }
        } catch (error: any) {
            failedCount++;
            console.error(`[MCP] ${config.name}: failed - ${error.message}`);
        } finally {
            await client.close();
        }
    }

    if (failedCount > 0) {
        throw new Error(`${failedCount} MCP server(s) failed`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
