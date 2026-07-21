import fs from 'fs/promises';
import path from 'path';

export type SkillManifest = {
    name: string;
    description: string;
    fileName: string;
};

export type SkillContent = SkillManifest & {
    content: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function getSkillsDir(): string {
    return path.resolve(process.env.SKILLS_DIR ?? 'skills');
}

export async function loadSkillManifests(skillsDir = getSkillsDir()): Promise<SkillManifest[]> {
    const files = await listSkillFiles(skillsDir);
    const manifests = await Promise.all(files.map(fileName => loadSkillManifest(skillsDir, fileName)));

    return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readSkill(name: string, skillsDir = getSkillsDir()): Promise<SkillContent> {
    const normalizedName = normalizeSkillName(name);
    if (!normalizedName) {
        throw new Error('skill name must be a non-empty string');
    }

    const files = await listSkillFiles(skillsDir);
    for (const fileName of files) {
        const content = await fs.readFile(resolveSkillFile(skillsDir, fileName), 'utf-8');
        const metadata = parseSkillMetadata(content, fileName);
        if (metadata.name.toLowerCase() === normalizedName) {
            return { ...metadata, content };
        }
    }

    throw new Error(`skill not found: ${name}`);
}

export function buildSkillManifestPrompt(manifests: SkillManifest[]): string {
    if (manifests.length === 0) return '';

    const rows = manifests.map(skill => `- ${skill.name}: ${skill.description}`);
    return [
        '【可用 Skills（仅目录）】',
        '当任务匹配某个 skill 时，先调用 load_skill 读取该 skill 全文，再按其中方法执行。不要假设未加载 skill 的细节。',
        ...rows
    ].join('\n');
}

async function listSkillFiles(skillsDir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
            .map(entry => entry.name)
            .sort();
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function loadSkillManifest(skillsDir: string, fileName: string): Promise<SkillManifest> {
    const content = await fs.readFile(resolveSkillFile(skillsDir, fileName), 'utf-8');
    return parseSkillMetadata(content, fileName);
}

function parseSkillMetadata(content: string, fileName: string): SkillManifest {
    const frontmatter = content.match(FRONTMATTER_PATTERN)?.[1] ?? '';
    const metadata = parseFrontmatter(frontmatter);
    if (!metadata.name || !metadata.description) {
        throw new Error(`invalid skill ${fileName}: frontmatter must define non-empty name and description`);
    }

    return {
        name: metadata.name,
        description: metadata.description,
        fileName
    };
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const line of frontmatter.split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
        if (key && value) result[key] = value;
    }

    return result;
}

function resolveSkillFile(skillsDir: string, fileName: string): string {
    const root = path.resolve(skillsDir);
    const resolved = path.resolve(root, fileName);
    const relative = path.relative(root, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`skill file is outside skills directory: ${fileName}`);
    }

    return resolved;
}

function normalizeSkillName(name: string): string {
    return name.trim().toLowerCase();
}
