import { IAgentTool } from '../types.js';
import { ApplyPatchTool, GitDiffTool, GitStatusTool, RunTestsTool } from './codingTool.js';
import { ListDirTool, ReadFileTool, WriteFileTool } from './fileTool.js';
import { ReadNoteTool, RelatedNotesTool, SearchNotesTool } from './ragTool.js';
import { GlobSearchTool, GrepSearchTool } from './searchTool.js';
import { ShellExecuteTool } from './shellTool.js';
import { LoadSkillTool } from './skillTool.js';

/**
 * 创建 CLI 默认暴露给 Agent 的工具集合。
 *
 * 新增工具时优先在这里加入实例，让 main.ts 只负责启动编排，
 * 避免入口文件随着工具数量增长而持续膨胀。
 */
export function createDefaultTools(): IAgentTool[] {
    return [
        new ListDirTool(),
        new ReadFileTool(),
        new WriteFileTool(),
        new GlobSearchTool(),
        new GrepSearchTool(),
        new SearchNotesTool(),
        new ReadNoteTool(),
        new RelatedNotesTool(),
        new LoadSkillTool(),
        new GitStatusTool(),
        new GitDiffTool(),
        new ApplyPatchTool(),
        new RunTestsTool(),
        new ShellExecuteTool()
    ];
}
