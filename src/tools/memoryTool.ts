import type { CreateMemoryProposalInput, MemoryProposal } from '../context/memoryProposal.js';
import { ToolResult } from '../types.js';
import { BaseAgentTool } from './base.js';

export type MemoryProposalService = {
    proposeMemory(input: CreateMemoryProposalInput): MemoryProposal;
};

export class ProposeMemoryTool extends BaseAgentTool {
    readonly name = 'propose_memory';
    readonly permission = 'write' as const;
    readonly riskLevel = 'write' as const;
    readonly isReadOnly = false;
    readonly requiresApproval = true;
    readonly schema = {
        type: 'function' as const,
        function: {
            name: 'propose_memory',
            description: '仅当用户明确要求“记住/保存偏好”时创建待人工审批的记忆提案；本工具不会写入长期记忆。',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: '用户明确要求记住的内容' },
                    kind: { type: 'string', enum: ['preference', 'constraint', 'fact'] },
                    userRequest: { type: 'string', description: '用户要求记住该内容的原始语句' },
                    sourceMessageRef: { type: 'string', description: '来源用户消息的稳定引用；没有消息 ID 时使用当前会话内描述' },
                    evidenceRefs: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '事实记忆所依据的 citation/chunk 引用'
                    }
                },
                required: ['content', 'userRequest', 'sourceMessageRef']
            }
        }
    };

    constructor(private readonly service: MemoryProposalService) {
        super();
    }

    validateArgs(args: unknown): string[] {
        if (!args || typeof args !== 'object') return ['args must be an object'];
        const value = args as Record<string, unknown>;
        const errors: string[] = [];
        for (const key of ['content', 'userRequest', 'sourceMessageRef']) {
            if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
                errors.push(`${key} must be a non-empty string`);
            }
        }
        if (value.kind !== undefined && !['preference', 'constraint', 'fact'].includes(String(value.kind))) {
            errors.push('kind must be preference, constraint, or fact');
        }
        if (value.evidenceRefs !== undefined && (!Array.isArray(value.evidenceRefs)
            || value.evidenceRefs.some(item => typeof item !== 'string' || !item.trim()))) {
            errors.push('evidenceRefs must contain only non-empty strings');
        }
        return errors;
    }

    async execute(args: {
        content: string;
        kind?: 'preference' | 'constraint' | 'fact';
        userRequest: string;
        sourceMessageRef: string;
        evidenceRefs?: string[];
    }): Promise<ToolResult> {
        try {
            const proposal = this.service.proposeMemory({
                content: args.content,
                kind: args.kind,
                userRequest: args.userRequest,
                sourceMessageRefs: [args.sourceMessageRef],
                evidenceRefs: args.evidenceRefs
            });
            return this.ok({
                proposalId: proposal.id,
                status: proposal.status,
                verification: proposal.verification,
                message: proposal.status === 'pending_approval'
                    ? '提案已核验，等待用户通过 REPL approve 命令批准'
                    : '提案未通过确定性核验，未写入长期记忆'
            });
        } catch (error: any) {
            return this.error(error.message);
        }
    }
}
