import { IAgentTool } from '../types.js';
import { BaseAgentTool } from './base.js';

export const TOOL_GROUPS = ['core', 'filesystem', 'git', 'sqlite', 'coding', 'shell'] as const;
export type ToolGroupName = typeof TOOL_GROUPS[number];

type ToolGroupManifestItem = {
    name: ToolGroupName;
    description: string;
};

export const TOOL_GROUP_MANIFEST: ToolGroupManifestItem[] = [
    { name: 'core', description: '知识库检索、笔记读取、skill 加载和工具组加载。默认始终可用。' },
    { name: 'filesystem', description: '文件读取、写入、目录查看、文件搜索等文件系统能力。' },
    { name: 'git', description: 'Git 状态、diff、log、branch、commit 等版本控制能力。' },
    { name: 'sqlite', description: 'SQLite 表结构查看、读查询、写查询和本地结构化记忆能力。' },
    { name: 'coding', description: '应用补丁和运行测试等代码修改验证能力。' },
    { name: 'shell', description: '受限 shell 命令执行能力。风险较高，仅必要时加载。' }
];

const CORE_TOOL_NAMES = new Set([
    'search_notes',
    'grep_notes',
    'read_note',
    'related_notes',
    'load_skill',
    'load_tool_group'
]);

export class ToolExposureController {
    private readonly activeGroups = new Set<ToolGroupName>(['core']);

    activateGroup(group: ToolGroupName): void {
        this.activeGroups.add(group);
    }

    resetToCore(): void {
        this.activeGroups.clear();
        this.activeGroups.add('core');
    }

    getActiveGroups(): ToolGroupName[] {
        return Array.from(this.activeGroups);
    }

    shouldExpose(tool: IAgentTool): boolean {
        return this.activeGroups.has(resolveToolGroup(tool.name));
    }
}

export class LoadToolGroupTool extends BaseAgentTool {
    readonly name = 'load_tool_group';
    readonly permission = 'read' as const;
    readonly riskLevel = 'safe' as const;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'load_tool_group',
            description: `按需加载一组工具 schema。默认只暴露 core 工具；当任务需要文件系统、Git、SQLite、代码修改或 shell 能力时，先调用这个工具加载对应分组。可用分组：${TOOL_GROUP_MANIFEST.map(item => `${item.name}=${item.description}`).join('；')}`,
            parameters: {
                type: 'object',
                properties: {
                    group: {
                        type: 'string',
                        enum: TOOL_GROUPS.filter(group => group !== 'core'),
                        description: '要加载的工具分组'
                    }
                },
                required: ['group']
            }
        }
    };

    constructor(private readonly exposureController: ToolExposureController) {
        super();
    }

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const group = (args as { group?: unknown }).group;
        return isLoadableToolGroup(group) ? [] : [`group must be one of: ${TOOL_GROUPS.filter(item => item !== 'core').join(', ')}`];
    }

    async execute(args: { group: ToolGroupName }) {
        this.exposureController.activateGroup(args.group);
        return this.ok({
            group: args.group,
            activeGroups: this.exposureController.getActiveGroups(),
            message: `Tool group "${args.group}" is now available in the next planning step.`
        });
    }
}

export function resolveToolGroup(toolName: string): ToolGroupName {
    if (CORE_TOOL_NAMES.has(toolName)) return 'core';
    if (toolName === 'apply_patch' || toolName === 'run_tests') return 'coding';
    if (toolName === 'execute_command') return 'shell';
    if (toolName.startsWith('mcp_sqlite_')) return 'sqlite';
    if (toolName.startsWith('mcp_git_') || toolName.startsWith('git_')) return 'git';
    if (toolName.startsWith('mcp_fs_') || ['list_dir', 'read_file', 'write_file', 'glob_search', 'grep_search'].includes(toolName)) {
        return 'filesystem';
    }

    return 'core';
}

function isLoadableToolGroup(value: unknown): value is ToolGroupName {
    return typeof value === 'string' && value !== 'core' && (TOOL_GROUPS as readonly string[]).includes(value);
}
