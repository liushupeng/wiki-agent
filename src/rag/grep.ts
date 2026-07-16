import fs from 'fs/promises';
import path from 'path';
import { getSupportedSourceExtensions } from './chunker.js';
import { SearchResult } from './types.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'var']);
const SUPPORTED_EXTENSIONS = new Set(getSupportedSourceExtensions());

export type GrepNotesMatch = {
    source: string;
    line: number;
    text: string;
    before: string[];
    after: string[];
};

export type GrepNotesOptions = {
    regex?: boolean;
    maxResults?: number;
    contextLines?: number;
    maxFiles?: number;
    ignorePatterns?: string[];
};

export async function grepNotes(rootDir: string, query: string, options: GrepNotesOptions = {}): Promise<GrepNotesMatch[]> {
    const root = path.resolve(rootDir);
    const matcher = createMatcher(query, options.regex ?? false);
    const maxResults = Math.min(options.maxResults ?? 50, 200);
    const contextLines = Math.min(options.contextLines ?? 1, 5);
    const files = await walkSupportedFiles(root, root, options.maxFiles ?? 5000, options.ignorePatterns ?? []);
    const matches: GrepNotesMatch[] = [];

    for (const file of files) {
        if (matches.length >= maxResults) break;

        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const text = lines[index];
            if (!matcher(text)) continue;

            matches.push({
                source: path.relative(root, file).replace(/\\/g, '/'),
                line: index + 1,
                text: text.trim(),
                before: lines.slice(Math.max(0, index - contextLines), index).map(line => line.trim()),
                after: lines.slice(index + 1, index + 1 + contextLines).map(line => line.trim())
            });
            if (matches.length >= maxResults) break;
        }
    }

    return matches;
}

export function grepMatchesToSearchResults(matches: GrepNotesMatch[], query: string): SearchResult[] {
    return matches.map((match, index) => ({
        id: `${match.source}:${match.line}:${index}`,
        source: match.source,
        text: [match.before.join('\n'), match.text, match.after.join('\n')].filter(Boolean).join('\n'),
        start: match.line,
        end: match.line,
        vector: {},
        score: scoreGrepMatch(match, query)
    }));
}

async function walkSupportedFiles(root: string, currentDir: string, maxFiles: number, ignorePatterns: string[], files: string[] = []): Promise<string[]> {
    if (files.length >= maxFiles) return files;

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (DEFAULT_IGNORES.has(entry.name)) continue;

        const fullPath = path.join(currentDir, entry.name);
        if (matchesIgnorePattern(root, fullPath, entry.isDirectory(), ignorePatterns)) continue;

        if (entry.isDirectory()) {
            await walkSupportedFiles(root, fullPath, maxFiles, ignorePatterns, files);
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }

    return files;
}

function createMatcher(query: string, regex: boolean): (line: string) => boolean {
    if (regex) {
        const matcher = new RegExp(query, 'i');
        return line => matcher.test(line);
    }

    const normalizedQuery = query.toLowerCase();
    return line => line.toLowerCase().includes(normalizedQuery);
}

function scoreGrepMatch(match: GrepNotesMatch, query: string): number {
    const text = match.text.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    return text.includes(normalizedQuery) ? 1 : 0.5;
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
