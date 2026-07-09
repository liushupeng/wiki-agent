import { APPROVAL_MODES, ApprovalMode } from './types.js';

type Env = Record<string, string | undefined>;

/**
 * 从环境变量解析工具审批模式。
 *
 * 审批模式只由 APPROVAL_MODE 控制；非法值会回退到 prompt。
 */
export function getApprovalMode(env: Env = process.env): ApprovalMode {
    const value = (env.APPROVAL_MODE ?? 'prompt').toLowerCase();
    return isApprovalMode(value) ? value : 'prompt';
}

function isApprovalMode(value: string): value is ApprovalMode {
    return (APPROVAL_MODES as readonly string[]).includes(value);
}
