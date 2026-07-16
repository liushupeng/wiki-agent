import path from 'path';

export type KnowledgeSourceRoot = {
    prefix: string;
    root: string;
};

/**
 * 多知识源配置。
 *
 * 格式：prefix=path;prefix=path，例如：
 * KNOWLEDGE_SOURCE_ROOTS=wiki=wiki;raw=notes
 *
 * prefix 会写入 chunk.source，便于检索结果区分 maintained wiki 和 raw sources。
 */
export function getKnowledgeSourceRoots(env: Record<string, string | undefined> = process.env): KnowledgeSourceRoot[] {
    const configured = env.KNOWLEDGE_SOURCE_ROOTS?.trim();
    if (configured) return parseKnowledgeSourceRoots(configured);

    return [{
        prefix: 'notes',
        root: env.NOTES_ROOT ?? 'notes'
    }];
}

export function parseKnowledgeSourceRoots(value: string): KnowledgeSourceRoot[] {
    const roots = value
        .split(';')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(parseSourceRootEntry);

    if (roots.length === 0) {
        throw new Error('KNOWLEDGE_SOURCE_ROOTS must contain at least one source root');
    }

    return roots;
}

export function sourceWithPrefix(prefix: string, relativeSource: string): string {
    return [normalizePrefix(prefix), relativeSource.replace(/\\/g, '/')]
        .filter(Boolean)
        .join('/');
}

export function isWikiSource(source: string): boolean {
    return source.replace(/\\/g, '/').toLowerCase().startsWith('wiki/');
}

function parseSourceRootEntry(entry: string): KnowledgeSourceRoot {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
        const root = entry;
        return { prefix: normalizePrefix(path.basename(root)), root };
    }

    const prefix = normalizePrefix(entry.slice(0, separatorIndex));
    const root = entry.slice(separatorIndex + 1).trim();
    if (!prefix) throw new Error(`invalid source root prefix: ${entry}`);
    if (!root) throw new Error(`invalid source root path: ${entry}`);
    return { prefix, root };
}

function normalizePrefix(prefix: string): string {
    return prefix.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
