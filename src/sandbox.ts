import path from 'path';
import fs from 'node:fs/promises';

export function getSandboxRoot(): string {
    return path.resolve(process.env.AGENT_SANDBOX_ROOT ?? 'C:\\AgentSandbox');
}

export function resolveSafePath(targetPath: string): string {
    const sandboxRoot = getSandboxRoot();
    const resolved = path.resolve(sandboxRoot, targetPath || '.');
    assertPathInside(sandboxRoot, resolved, `[安全拦截] 目标路径 [${targetPath}] 不在安全沙盒内。`);

    return resolved;
}

export async function resolveSafeExistingPath(targetPath: string): Promise<string> {
    return resolveExistingPathWithinRoot(getSandboxRoot(), targetPath || '.', '安全沙盒');
}

export async function resolveExistingPathWithinRoot(
    rootPath: string,
    targetPath: string,
    label: string
): Promise<string> {
    const root = path.resolve(rootPath);
    const lexicalTarget = path.resolve(root, targetPath || '.');
    assertPathInside(root, lexicalTarget, `[安全拦截] 目标路径 [${targetPath}] 不在${label}内。`);

    const realRoot = await fs.realpath(root);
    await rejectSymbolicPathComponents(root, lexicalTarget, targetPath);
    const realTarget = await fs.realpath(lexicalTarget);
    assertPathInside(realRoot, realTarget, `[安全拦截] 目标路径 [${targetPath}] 通过符号链接逃出${label}。`);
    return realTarget;
}

export function toSandboxRelativePath(absolutePath: string): string {
    return path.relative(getSandboxRoot(), absolutePath).replace(/\\/g, '/');
}

async function rejectSymbolicPathComponents(root: string, target: string, original: string): Promise<void> {
    const relative = path.relative(root, target);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`[安全拦截] 目标路径 [${original}] 包含符号链接。`);
        }
    }
}

function assertPathInside(root: string, target: string, message: string): void {
    const relative = path.relative(root, target);
    const normalizedRoot = normalizeForComparison(root);
    const normalizedTarget = normalizeForComparison(target);
    if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`))
    ) {
        throw new Error(message);
    }
}

function normalizeForComparison(value: string): string {
    return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}
