import OpenAI from 'openai';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { limitText } from '../limits.js';
import { ToolPermission, ToolResult, ToolRiskLevel } from '../types.js';
import { BaseAgentTool } from '../tools/base.js';
import { McpServerConfig } from './config.js';
import { McpClientLike } from './client.js';

export class McpAgentTool extends BaseAgentTool {
    readonly name: string;
    readonly permission: ToolPermission;
    readonly riskLevel: ToolRiskLevel;
    readonly isReadOnly: boolean;
    readonly requiresApproval: boolean;
    readonly schema: OpenAI.Chat.Completions.ChatCompletionTool;

    constructor(
        private readonly client: McpClientLike,
        private readonly serverConfig: McpServerConfig,
        private readonly remoteTool: Tool
    ) {
        super();
        this.name = buildMcpToolName(serverConfig.toolNamePrefix, remoteTool.name);
        this.riskLevel = inferRiskLevel(remoteTool, serverConfig.defaultRiskLevel);
        this.permission = inferPermission(remoteTool, serverConfig.defaultPermission, this.riskLevel);
        this.isReadOnly = this.riskLevel === 'safe';
        this.requiresApproval = this.riskLevel !== 'safe';
        this.schema = {
            type: 'function',
            function: {
                name: this.name,
                description: buildDescription(serverConfig.name, remoteTool),
                parameters: remoteTool.inputSchema
            }
        };
    }

    validateArgs(args: unknown): string[] {
        return typeof args === 'object' && args !== null && !Array.isArray(args)
            ? []
            : ['MCP tool arguments must be an object'];
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const result = await this.client.callTool({
            name: this.remoteTool.name,
            arguments: args
        });
        const contentText = stringifyMcpContent(result);
        const limited = limitText(contentText);
        const metadata = {
            mcpServer: this.serverConfig.name,
            mcpTool: this.remoteTool.name,
            mcpToolName: this.name,
            truncated: limited.truncated,
            isError: 'isError' in result ? result.isError === true : false
        };

        if ('isError' in result && result.isError) {
            return this.executionFailed(limited.text || 'MCP tool returned an error', metadata);
        }

        return this.ok({
            content: limited.text,
            ...('structuredContent' in result && result.structuredContent ? { structuredContent: result.structuredContent } : {})
        }, metadata);
    }
}

export function buildMcpToolName(prefix: string, remoteToolName: string): string {
    return sanitizeToolName(`${prefix}_${remoteToolName}`);
}

function sanitizeToolName(value: string): string {
    const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
    return normalized.slice(0, 64);
}

function inferRiskLevel(tool: Tool, defaultRiskLevel: ToolRiskLevel): ToolRiskLevel {
    if (tool.annotations?.destructiveHint) return 'write';
    if (tool.annotations?.openWorldHint) return 'network';
    // Server annotations are advisory and must not downgrade a conservative local policy.
    if (defaultRiskLevel !== 'safe') return defaultRiskLevel;
    if (tool.annotations?.readOnlyHint) return 'safe';
    return defaultRiskLevel;
}

function inferPermission(tool: Tool, defaultPermission: ToolPermission, riskLevel: ToolRiskLevel): ToolPermission {
    if (tool.annotations?.destructiveHint || riskLevel === 'write') return 'write';
    if (riskLevel === 'shell') return 'shell';
    return defaultPermission;
}

function buildDescription(serverName: string, tool: Tool): string {
    const title = tool.title ? `${tool.title}. ` : '';
    const description = tool.description ?? 'MCP server tool.';
    return `[MCP:${serverName}] ${title}${description}`;
}

function stringifyMcpContent(result: unknown): string {
    if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray((result as { content?: unknown }).content)) {
        return JSON.stringify(result);
    }

    return (result as { content: Array<Record<string, unknown>> }).content.map(item => {
        if (item.type === 'text') return String(item.text ?? '');
        if (item.type === 'resource') return `[resource] ${JSON.stringify(item.resource ?? {})}`;
        if (item.type === 'resource_link') return `[resource_link] ${String(item.uri ?? '')}`;
        if (item.type === 'image') return `[image] ${String(item.mimeType ?? '')}`;
        if (item.type === 'audio') return `[audio] ${String(item.mimeType ?? '')}`;
        return JSON.stringify(item);
    }).filter(Boolean).join('\n');
}
