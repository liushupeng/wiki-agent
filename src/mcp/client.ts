import { IOType } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpServerConfig } from './config.js';

export type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface McpClientLike {
    listTools(): Promise<{ tools: Tool[] }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult>;
}

export class StdioMcpClient implements McpClientLike {
    private client?: Client;
    private transport?: StdioClientTransport;

    constructor(
        private readonly config: McpServerConfig,
        private readonly stderr: IOType = 'pipe'
    ) {}

    async connect(): Promise<void> {
        if (this.client) return;

        const client = new Client({
            name: 'wiki-agent',
            version: '1.0.0'
        });
        const transport = new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
            ...(this.config.env ? { env: this.config.env } : {}),
            stderr: this.stderr
        });

        await client.connect(transport);
        this.client = client;
        this.transport = transport;
    }

    async listTools(): Promise<{ tools: Tool[] }> {
        const client = this.requireClient();
        return client.listTools();
    }

    async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult> {
        const client = this.requireClient();
        return client.callTool({
            name: params.name,
            arguments: params.arguments ?? {}
        });
    }

    async close(): Promise<void> {
        await this.transport?.close();
        this.client = undefined;
        this.transport = undefined;
    }

    private requireClient(): Client {
        if (!this.client) {
            throw new Error(`MCP server is not connected: ${this.config.name}`);
        }

        return this.client;
    }
}
