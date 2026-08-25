import path from 'node:path';

export const SANDBOX_RELATIVE_ROOT = 'var/sandbox';

export function getWorkspaceRoot(): string {
    return path.resolve(process.env.AGENT_WORKSPACE_ROOT ?? process.cwd());
}

export function getCanonicalSandboxRoot(): string {
    return path.resolve(getWorkspaceRoot(), SANDBOX_RELATIVE_ROOT);
}
