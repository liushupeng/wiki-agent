import { readSkill } from '../skills.js';
import { ToolResult } from '../types.js';
import { BaseAgentTool } from './base.js';

export class LoadSkillTool extends BaseAgentTool {
    readonly name = 'load_skill';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'load_skill',
            description: '按 skill 名称读取单个 skill 的完整说明。只有任务明确匹配 skill manifest 时才调用。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'skill 名称，例如 knowledge-rag 或 note-curation' }
                },
                required: ['name']
            }
        }
    };

    validateArgs(args: unknown): string[] {
        if (typeof args !== 'object' || args === null) return ['args must be an object'];
        const name = (args as { name?: unknown }).name;
        return typeof name === 'string' && name.trim() ? [] : ['name must be a non-empty string'];
    }

    async execute(args: { name: string }): Promise<ToolResult> {
        try {
            const skill = await readSkill(args.name);

            return this.ok({
                name: skill.name,
                description: skill.description,
                fileName: skill.fileName,
                content: skill.content
            });
        } catch (error: any) {
            return this.error(error.message, {
                hint: '请先查看 system prompt 中的 skill manifest，并传入 manifest 里的 skill name。'
            });
        }
    }
}
