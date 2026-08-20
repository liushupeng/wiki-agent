import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import '../../src/env.js';
import { loadKnowledgeCatalog, KNOWLEDGE_STATUSES } from '../../src/rag/knowledgeCatalog.js';
import { getKnowledgeSourceRoots } from '../../src/rag/sourceRoots.js';

async function main(): Promise<void> {
    const catalog = await loadKnowledgeCatalog();
    const roots = await getKnowledgeSourceRoots();
    const counts = Object.fromEntries(KNOWLEDGE_STATUSES.map(status => [status, 0])) as Record<string, number>;
    const issues: string[] = [];

    for (const record of catalog.data.records) {
        counts[record.status] = (counts[record.status] ?? 0) + 1;
        const [prefix, ...relativeParts] = record.sourceId.replace(/\\/g, '/').split('/');
        const root = roots.find(candidate => candidate.prefix === prefix);
        if (!root) {
            issues.push(`${record.sourceId}: unknown knowledge source prefix "${prefix}"`);
            continue;
        }
        const absolutePath = path.resolve(root.root, relativeParts.join('/'));
        if (!isInside(path.resolve(root.root), absolutePath)) {
            issues.push(`${record.sourceId}: path escapes its configured source root`);
            continue;
        }
        try {
            const content = await fs.readFile(absolutePath);
            if (record.status === 'deleted') {
                issues.push(`${record.sourceId}: status is deleted but the source file still exists`);
            }
            if (record.contentHash) {
                const actual = createHash('sha256').update(content).digest('hex');
                if (actual !== record.contentHash) issues.push(`${record.sourceId}: contentHash does not match the current file`);
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT' || record.status !== 'deleted') {
                issues.push(`${record.sourceId}: source file is unavailable (${error.message})`);
            }
        }
    }

    console.log(JSON.stringify({
        catalog: catalog.identity,
        records: catalog.data.records.length,
        statusCounts: counts,
        claimCount: catalog.data.records.reduce((sum, record) => sum + (record.claims?.length ?? 0), 0),
        healthy: issues.length === 0,
        issues
    }, null, 2));
    if (issues.length > 0) process.exitCode = 1;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
