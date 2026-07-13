import { BaseAgentTool } from '../tools/base.js';
import { ToolResult } from '../types.js';

export class SafeTool extends BaseAgentTool {
    readonly name: string = 'safe_tool';
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'safe_tool',
            description: 'test tool',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    };

    async execute(): Promise<ToolResult> {
        return this.ok({});
    }
}

export class WriteTool extends SafeTool {
    readonly name = 'write_tool';
    readonly permission = 'write' as const;
    readonly riskLevel = 'write' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
}

export class ShellTool extends SafeTool {
    readonly name = 'shell_tool';
    readonly permission = 'shell' as const;
    readonly riskLevel = 'shell' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
}
