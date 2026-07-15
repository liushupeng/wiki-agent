import OpenAI from 'openai';
import { Color } from '../cli/colors.js';
import { IAgentTool, IToolRegistry, ToolResult } from '../types.js';
import { parseToolArguments } from '../utils/json.js';

export class ToolRegistry implements IToolRegistry {
    private tools = new Map<string, IAgentTool>();
    private schemaFilter?: (tool: IAgentTool) => boolean;

    register(tool: IAgentTool): void {
        this.tools.set(tool.name, tool);
        console.log(Color.green(`🔧 工具注册：[${tool.name}] (${tool.permission})`));
    }

    getSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return Array.from(this.tools.values())
            .filter(tool => this.schemaFilter?.(tool) ?? true)
            .map(tool => tool.schema);
    }

    setSchemaFilter(filter: (tool: IAgentTool) => boolean): void {
        this.schemaFilter = filter;
    }

    async execute(name: string, argsStr: string): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`未找到工具: ${name}`);

        const parsedArgs = parseToolArguments(argsStr);
        if (!parsedArgs.ok) {
            return { status: 'invalid_args', error: `invalid JSON arguments: ${parsedArgs.error}` };
        }

        const validationErrors = tool.validateArgs?.(parsedArgs.value) ?? [];
        if (validationErrors.length > 0) {
            return { status: 'invalid_args', error: validationErrors.join('; ') };
        }

        return await tool.execute(parsedArgs.value);
    }

    getTool(name: string): IAgentTool | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }
}
