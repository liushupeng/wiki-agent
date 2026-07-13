import path from 'path';

export function getSandboxRoot(): string {
    return path.resolve(process.env.AGENT_SANDBOX_ROOT ?? 'C:\\AgentSandbox');
}

export function resolveSafePath(targetPath: string): string {
    const sandboxRoot = getSandboxRoot();
    const resolved = path.resolve(sandboxRoot, targetPath || '.');
    const relative = path.relative(sandboxRoot, resolved);
    const normalizedRoot = normalizeForComparison(sandboxRoot);
    const normalizedResolved = normalizeForComparison(resolved);

    if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`))
    ) {
        throw new Error(`[安全拦截] 目标路径 [${targetPath}] 不在安全沙盒内。`);
    }

    return resolved;
}

export function toSandboxRelativePath(absolutePath: string): string {
    return path.relative(getSandboxRoot(), absolutePath).replace(/\\/g, '/');
}

function normalizeForComparison(value: string): string {
    return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}
