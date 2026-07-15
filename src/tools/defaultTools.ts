import { IAgentTool } from '../types.js';
import { ApplyPatchTool, GitDiffTool, GitStatusTool, RunTestsTool } from './codingTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './fileTool.js';
import { GrepNotesTool, ReadNoteTool, RelatedNotesTool, SearchNotesTool } from './ragTool.js';
import { GlobSearchTool, GrepSearchTool } from './searchTool.js';
import { ShellExecuteTool } from './shellTool.js';
import { LoadSkillTool } from './skillTool.js';

export type McpToolCoverageInfo = {
    remoteToolName: string;
};

type CreateDefaultToolsOptions = {
    skipToolNames?: Iterable<string>;
};

const LOCAL_TOOLS_COVERED_BY_MCP_REMOTE_TOOL: Record<string, string[]> = {
    read_file: ['read_file'],
    read_text_file: ['read_file'],
    write_file: ['write_file'],
    list_directory: ['list_dir'],
    list_directory_with_sizes: ['list_dir'],
    directory_tree: ['list_dir'],
    search_files: ['glob_search'],
    git_status: ['git_status'],
    git_diff: ['git_diff'],
    git_diff_staged: ['git_diff'],
    git_diff_unstaged: ['git_diff']
};

/**
 * 创建 CLI 默认暴露给 Agent 的工具集合。
 *
 * 新增工具时优先在这里加入实例，让 main.ts 只负责启动编排，
 * 避免入口文件随着工具数量增长而持续膨胀。
 */
export function createDefaultTools(options: CreateDefaultToolsOptions = {}): IAgentTool[] {
    const skipToolNames = new Set(options.skipToolNames ?? []);
    return [
        new ListDirTool(),
        new ReadFileTool(),
        new WriteFileTool(),
        new GlobSearchTool(),
        new GrepSearchTool(),
        new SearchNotesTool(),
        new GrepNotesTool(),
        new ReadNoteTool(),
        new RelatedNotesTool(),
        new LoadSkillTool(),
        new GitStatusTool(),
        new GitDiffTool(),
        new ApplyPatchTool(),
        new RunTestsTool(),
        new ShellExecuteTool()
    ].filter(tool => !skipToolNames.has(tool.name));
}

/**
 * MCP 工具名和本地工具名通常不会直接冲突，因为 MCP adapter 会加前缀。
 * 这里按“能力等价”过滤本地工具，避免模型同时看到两套做同一件事的工具。
 */
export function getLocalToolNamesCoveredByMcp(mcpTools: Iterable<McpToolCoverageInfo>): Set<string> {
    const coveredLocalToolNames = new Set<string>();
    for (const tool of mcpTools) {
        for (const localToolName of LOCAL_TOOLS_COVERED_BY_MCP_REMOTE_TOOL[tool.remoteToolName] ?? []) {
            coveredLocalToolNames.add(localToolName);
        }
    }

    return coveredLocalToolNames;
}
