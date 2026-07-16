import fs from 'fs/promises';
import path from 'path';
import { getSupportedSourceExtensions } from './chunker.js';
import { SourceDocument } from './types.js';
import { KnowledgeSourceRoot, sourceWithPrefix } from './sourceRoots.js';

export const DEFAULT_SOURCE_EXTENSIONS = new Set(getSupportedSourceExtensions());
export const DEFAULT_IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);

export type DocumentLoaderOptions = {
    extensions?: Iterable<string>;
    ignoreDirs?: Iterable<string>;
    ignorePatterns?: Iterable<string>;
    sourcePrefix?: string;
};

/**
 * 扫描可索引的源文件。
 *
 * 这个函数只负责“哪些文件进入索引”，不关心文件怎么切分、怎么 embedding。
 * 后续支持 PDF/HTML/代码文件时，可以通过 extensions 扩展入口文件类型。
 */
export async function walkSourceFiles(root: string, options: DocumentLoaderOptions = {}): Promise<string[]> {
    const resolvedRoot = path.resolve(root);
    const extensions = normalizeSet(options.extensions ?? DEFAULT_SOURCE_EXTENSIONS);
    const ignoreDirs = normalizeSet(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
    const ignorePatterns = Array.from(options.ignorePatterns ?? []);
    const files: string[] = [];

    await walk(resolvedRoot, resolvedRoot, extensions, ignoreDirs, ignorePatterns, files);
    return files;
}

/**
 * 把磁盘文件读取成 SourceDocument。
 *
 * SourceDocument 是后续 chunker 的输入，包含相对 source、绝对路径、扩展名和正文内容。
 */
export async function loadSourceDocuments(root: string, options: DocumentLoaderOptions = {}): Promise<SourceDocument[]> {
    const resolvedRoot = path.resolve(root);
    const files = await walkSourceFiles(resolvedRoot, options);
    const sourcePrefix = options.sourcePrefix?.trim();

    return Promise.all(files.map(async file => {
        const extension = path.extname(file).toLowerCase();
        const relativeSource = path.relative(resolvedRoot, file).replace(/\\/g, '/');
        return {
            source: sourcePrefix ? sourceWithPrefix(sourcePrefix, relativeSource) : relativeSource,
            absolutePath: file,
            extension,
            content: await fs.readFile(file, 'utf-8')
        };
    }));
}

export async function loadSourceDocumentsFromRoots(sourceRoots: KnowledgeSourceRoot[], options: DocumentLoaderOptions = {}): Promise<SourceDocument[]> {
    const groups = await Promise.all(sourceRoots.map(sourceRoot => loadSourceDocuments(path.resolve(sourceRoot.root), {
        ...options,
        sourcePrefix: sourceRoot.prefix,
        ignorePatterns: [...(options.ignorePatterns ?? []), ...sourceRoot.ignore]
    })));

    return groups.flat();
}

async function walk(root: string, currentDir: string, extensions: Set<string>, ignoreDirs: Set<string>, ignorePatterns: string[], files: string[]): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory() && ignoreDirs.has(entry.name)) continue;

        const fullPath = path.join(currentDir, entry.name);
        if (matchesIgnorePattern(root, fullPath, entry.isDirectory(), ignorePatterns)) continue;

        if (entry.isDirectory()) {
            await walk(root, fullPath, extensions, ignoreDirs, ignorePatterns, files);
        } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }
}

function normalizeSet(values: Iterable<string>): Set<string> {
    return new Set(Array.from(values, value => value.toLowerCase()));
}

function matchesIgnorePattern(root: string, fullPath: string, isDirectory: boolean, patterns: string[]): boolean {
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
    const pathForMatch = isDirectory ? `${relativePath}/` : relativePath;
    return patterns.some(pattern => globToRegExp(pattern).test(pathForMatch));
}

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    let source = '';

    for (let index = 0; index < normalized.length;) {
        const char = normalized[index];
        const next = normalized[index + 1];
        const afterNext = normalized[index + 2];

        if (char === '*' && next === '*' && afterNext === '/') {
            source += '(?:.*/)?';
            index += 3;
        } else if (char === '*' && next === '*') {
            source += '.*';
            index += 2;
        } else if (char === '*') {
            source += '[^/]*';
            index += 1;
        } else {
            source += escapeRegExp(char);
            index += 1;
        }
    }

    return new RegExp(`^${source}$`, 'i');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
