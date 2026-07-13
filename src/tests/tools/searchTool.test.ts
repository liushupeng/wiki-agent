import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GlobSearchTool, GrepSearchTool } from '../../tools/searchTool.js';

async function withSandbox<T>(run: (root: string) => Promise<T>): Promise<T> {
    const previousRoot = process.env.AGENT_SANDBOX_ROOT;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-search-tool-'));
    process.env.AGENT_SANDBOX_ROOT = root;

    try {
        return await run(root);
    } finally {
        if (previousRoot === undefined) {
            delete process.env.AGENT_SANDBOX_ROOT;
        } else {
            process.env.AGENT_SANDBOX_ROOT = previousRoot;
        }
    }
}

test('GlobSearchTool finds files inside the runtime sandbox', async () => {
    await withSandbox(async root => {
        await fs.mkdir(path.join(root, 'notes'), { recursive: true });
        await fs.writeFile(path.join(root, 'notes', 'agent.md'), '# Agent');
        await fs.writeFile(path.join(root, 'notes', 'ignore.txt'), 'ignore');

        const result = await new GlobSearchTool().execute({ pattern: 'notes/*.md' });

        assert.equal(result.status, 'success');
        assert.deepEqual(result.data, { matches: ['notes/agent.md'] });
    });
});

test('GrepSearchTool finds plain text matches inside the runtime sandbox', async () => {
    await withSandbox(async root => {
        await fs.mkdir(path.join(root, 'notes'), { recursive: true });
        await fs.writeFile(path.join(root, 'notes', 'agent.md'), 'Agentic RAG\nsecond line');

        const result = await new GrepSearchTool().execute({ query: 'rag' });

        assert.equal(result.status, 'success');
        assert.deepEqual(result.data, {
            matches: [{ file: 'notes/agent.md', line: 1, text: 'Agentic RAG' }]
        });
    });
});

test('GrepSearchTool supports regex matches', async () => {
    await withSandbox(async root => {
        await fs.mkdir(path.join(root, 'notes'), { recursive: true });
        await fs.writeFile(path.join(root, 'notes', 'agent.md'), 'Step 42: retrieve evidence');

        const result = await new GrepSearchTool().execute({ query: 'step \\d+', regex: true });

        assert.equal(result.status, 'success');
        assert.deepEqual(result.data, {
            matches: [{ file: 'notes/agent.md', line: 1, text: 'Step 42: retrieve evidence' }]
        });
    });
});

test('search tools return errors for paths outside the sandbox', async () => {
    await withSandbox(async () => {
        const result = await new GlobSearchTool().execute({ pattern: '**/*.md', relativePath: '..' });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /不在安全沙盒内/);
    });
});
