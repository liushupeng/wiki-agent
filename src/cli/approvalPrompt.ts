import { ApprovalRequest } from '../types.js';

export type QuestionPrompt = {
    question(query: string): Promise<string>;
};

/**
 * CLI 层的人审提示适配器。
 *
 * PermissionPolicy 负责判断工具是否需要人工审批；这里仅负责在需要审批时
 * 展示工具风险、参数和原因，并把用户输入转换成允许/拒绝的布尔结果。
 */
export async function askToolApproval(prompt: QuestionPrompt, request: ApprovalRequest): Promise<boolean> {
    console.log('\n[Tool approval required]');
    console.log(`tool: ${request.toolName}`);
    console.log(`risk: ${request.riskLevel}`);
    console.log(`reason: ${request.reason}`);
    console.log(`args: ${JSON.stringify(request.args, null, 2)}`);

    const answer = (await prompt.question('Approve tool execution? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
}
