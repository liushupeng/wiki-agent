import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolPermission, ToolRiskLevel } from '../types.js';
import { parseJsonc } from '../utils/jsonc.js';

type Env = Record<string, string | undefined>;

export type McpServerConfig = {
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    toolNamePrefix: string;
    defaultPermission: ToolPermission;
    defaultRiskLevel: ToolRiskLevel;
    enabled: boolean;
};

type RawMcpServerConfig = {
    name?: unknown;
    command?: unknown;
    args?: unknown;
    cwd?: unknown;
    env?: unknown;
    enabled?: unknown;
    toolNamePrefix?: unknown;
    defaultPermission?: unknown;
    defaultRiskLevel?: unknown;
};

export async function loadMcpServerConfigs(env: Env = process.env): Promise<McpServerConfig[]> {
    const configPath = env.MCP_CONFIG_PATH?.trim();
    if (!configPath) return [];

    const absolutePath = path.resolve(configPath);

    let parsed: unknown;
    try {
        const rawValue = await fs.readFile(absolutePath, 'utf-8');
        parsed = parseJsonc(rawValue, `MCP config file "${absolutePath}"`);
    } catch (error: any) {
        if (String(error.message).startsWith('invalid MCP config file')) throw error;
        throw new Error(`invalid MCP config file "${absolutePath}": ${error.message}`);
    }

    const configs = readMcpConfigEntries(parsed);
    if (!configs) {
        throw new Error(`invalid MCP config file "${absolutePath}": expected a "servers" array`);
    }

    return configs
        .map((value, index) => normalizeMcpServerConfig(value as RawMcpServerConfig, index))
        .filter(config => config.enabled);
}

function readMcpConfigEntries(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'object' || value === null) return undefined;
    const servers = (value as Record<string, unknown>).servers;
    return Array.isArray(servers) ? servers : undefined;
}

function normalizeMcpServerConfig(value: RawMcpServerConfig, index: number): McpServerConfig {
    if (typeof value !== 'object' || value === null) {
        throw new Error(`invalid MCP server config at index ${index}: expected an object`);
    }

    if (typeof value.name !== 'string' || !value.name.trim()) {
        throw new Error(`invalid MCP server config at index ${index}: name must be a non-empty string`);
    }

    if (typeof value.command !== 'string' || !value.command.trim()) {
        throw new Error(`invalid MCP server config "${value.name}": command must be a non-empty string`);
    }

    const args = value.args === undefined
        ? []
        : Array.isArray(value.args) && value.args.every(item => typeof item === 'string')
            ? value.args
            : undefined;
    if (!args) {
        throw new Error(`invalid MCP server config "${value.name}": args must be a string array`);
    }

    return {
        name: value.name.trim(),
        command: value.command.trim(),
        args,
        ...(typeof value.cwd === 'string' && value.cwd.trim() ? { cwd: value.cwd } : {}),
        ...(isStringRecord(value.env) ? { env: value.env } : {}),
        toolNamePrefix: typeof value.toolNamePrefix === 'string' && value.toolNamePrefix.trim()
            ? value.toolNamePrefix.trim()
            : `mcp_${value.name.trim()}`,
        defaultPermission: isToolPermission(value.defaultPermission) ? value.defaultPermission : 'mcp',
        defaultRiskLevel: isToolRiskLevel(value.defaultRiskLevel) ? value.defaultRiskLevel : 'write',
        enabled: value.enabled !== false
    };
}

function isToolPermission(value: unknown): value is ToolPermission {
    return ['read', 'write', 'shell', 'rag', 'mcp'].includes(String(value));
}

function isToolRiskLevel(value: unknown): value is ToolRiskLevel {
    return ['safe', 'write', 'network', 'shell', 'dangerous'].includes(String(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object'
        && value !== null
        && Object.values(value).every(item => typeof item === 'string');
}
