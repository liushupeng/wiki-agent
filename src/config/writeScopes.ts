import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonc } from '../utils/jsonc.js';
import { getWorkspaceRoot, SANDBOX_RELATIVE_ROOT } from '../workspace.js';

type Env = Record<string, string | undefined>;

export type WriteScope = {
    name: string;
    root: string;
    description: string;
};

export type WriteScopesConfig = {
    defaultScope: string;
    scopes: WriteScope[];
};

type RawWriteScopesConfig = {
    defaultScope?: unknown;
    scopes?: unknown;
};

export async function loadWriteScopes(env: Env = process.env): Promise<WriteScopesConfig> {
    const configPath = env.WRITE_SCOPES_CONFIG_PATH?.trim();
    if (!configPath) return defaultWriteScopes();

    const absolutePath = path.resolve(configPath);
    let parsed: unknown;
    try {
        parsed = parseJsonc(await fs.readFile(absolutePath, 'utf-8'), `write scopes config file "${absolutePath}"`);
    } catch (error: any) {
        if (String(error.message).startsWith('invalid write scopes config file')) throw error;
        throw new Error(`invalid write scopes config file "${absolutePath}": ${error.message}`);
    }

    return normalizeWriteScopesConfig(parsed);
}

export function defaultWriteScopes(): WriteScopesConfig {
    return {
        defaultScope: 'sandbox',
        scopes: [{
            name: 'sandbox',
            root: SANDBOX_RELATIVE_ROOT,
            description: '默认隔离输出目录；普通文件写入不指定 scope 时使用此处。'
        }]
    };
}

export function resolveWriteScopeRoot(scope: WriteScope, workspaceRoot = getWorkspaceRoot()): string {
    if (path.isAbsolute(scope.root)) {
        throw new Error(`write scope "${scope.name}" root must be relative to the workspace`);
    }

    const resolvedRoot = path.resolve(workspaceRoot, scope.root);
    assertPathInside(workspaceRoot, resolvedRoot, `write scope "${scope.name}" root`);
    return resolvedRoot;
}

export async function resolveWriteScopePath(
    scope: WriteScope,
    filename: string,
    workspaceRoot = getWorkspaceRoot()
): Promise<string> {
    const scopeRoot = resolveWriteScopeRoot(scope, workspaceRoot);
    await fs.mkdir(scopeRoot, { recursive: true });

    const realWorkspaceRoot = await fs.realpath(workspaceRoot);
    const realScopeRoot = await fs.realpath(scopeRoot);
    assertPathInside(realWorkspaceRoot, realScopeRoot, `write scope "${scope.name}" root`);

    const target = path.resolve(realScopeRoot, filename);
    assertPathInside(realScopeRoot, target, 'target path');

    const targetDirectory = path.dirname(target);
    await fs.mkdir(targetDirectory, { recursive: true });
    const realTargetDirectory = await fs.realpath(targetDirectory);
    assertPathInside(realScopeRoot, realTargetDirectory, 'target path');

    try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
            throw new Error('target file must not be a symbolic link');
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
    }

    return target;
}

function normalizeWriteScopesConfig(value: unknown): WriteScopesConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('invalid write scopes config: expected an object');
    }

    const raw = value as RawWriteScopesConfig;
    if (typeof raw.defaultScope !== 'string' || !raw.defaultScope.trim()) {
        throw new Error('invalid write scopes config: defaultScope must be a non-empty string');
    }
    if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
        throw new Error('invalid write scopes config: scopes must be a non-empty array');
    }

    const names = new Set<string>();
    const scopes = raw.scopes.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`invalid write scopes config: scopes[${index}] must be an object`);
        }
        const typed = entry as Record<string, unknown>;
        const name = typeof typed.name === 'string' ? typed.name.trim() : '';
        const root = typeof typed.root === 'string' ? typed.root.trim() : '';
        const description = typeof typed.description === 'string' ? typed.description.trim() : '';
        if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
            throw new Error(`invalid write scopes config: scopes[${index}].name must use lowercase kebab-case`);
        }
        if (!root) throw new Error(`invalid write scopes config: scopes[${index}].root must be a non-empty string`);
        if (!description) throw new Error(`invalid write scopes config: scopes[${index}].description must be a non-empty string`);
        if (names.has(name)) throw new Error(`invalid write scopes config: duplicate scope "${name}"`);
        names.add(name);
        return { name, root, description };
    });

    const defaultScope = raw.defaultScope.trim();
    if (!names.has(defaultScope)) {
        throw new Error(`invalid write scopes config: defaultScope "${defaultScope}" is not declared`);
    }

    for (const scope of scopes) resolveWriteScopeRoot(scope);
    return { defaultScope, scopes };
}

function assertPathInside(root: string, target: string, label: string): void {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${label} is outside the workspace boundary`);
    }
}
