import { Color } from '../cli/colors.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadMcpServerConfigs, McpServerConfig } from './config.js';
import { StdioMcpClient } from './client.js';
import { McpAgentTool } from './toolAdapter.js';

export type RegisteredMcpTool = {
    serverName: string;
    remoteToolName: string;
    agentToolName: string;
};

export type McpRegistration = {
    tools: RegisteredMcpTool[];
    close(): Promise<void>;
};

export async function registerConfiguredMcpTools(registry: ToolRegistry): Promise<McpRegistration> {
    const configs = await loadMcpServerConfigs();
    const registeredTools: RegisteredMcpTool[] = [];
    const clients: StdioMcpClient[] = [];
    for (const config of configs) {
        const client = new StdioMcpClient(config);
        try {
            await client.connect();
            const { tools } = await client.listTools();
            for (const tool of tools) {
                if (!shouldRegisterMcpTool(config, tool.name)) continue;
                const agentTool = new McpAgentTool(client, config, tool);
                registry.register(agentTool);
                registeredTools.push({
                    serverName: config.name,
                    remoteToolName: tool.name,
                    agentToolName: agentTool.name
                });
            }
            clients.push(client);
            const registeredCount = tools.filter(tool => shouldRegisterMcpTool(config, tool.name)).length;
            console.log(Color.green(`🔌 MCP server connected: [${config.name}] (${registeredCount}/${tools.length} tools)`));
        } catch (error: any) {
            await client.close().catch(() => undefined);
            console.warn(Color.yellow(`⚠️ MCP server skipped: [${config.name}] ${error.message}`));
        }
    }

    return {
        tools: registeredTools,
        async close() {
            await Promise.allSettled(clients.map(client => client.close()));
        }
    };
}

export function shouldRegisterMcpTool(config: Pick<McpServerConfig, 'disabledTools'>, remoteToolName: string): boolean {
    return !config.disabledTools.includes(remoteToolName);
}
