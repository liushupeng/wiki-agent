import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GlobSearchTool, GrepSearchTool } from '../../tools/searchTool.js';

async function withSandbox<T>(run: (root: string) => Promise<T>): Promise<T> {
    const previousRoot = process.env.AGENT_WORKSPACE_ROOT;
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-search-tool-'));
    const root = path.join(workspaceRoot, 'var', 'sandbox');
    await fs.mkdir(root, { recursive: true });
    process.env.AGENT_WORKSPACE_ROOT = workspaceRoot;

    try {
        return await run(root);
    } finally {
        if (previousRoot === undefined) {
            delete process.env.AGENT_WORKSPACE_ROOT;
        } else {
            process.env.AGENT_WORKSPACE_ROOT = previousRoot;
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

test('search tools validate arguments', () => {
    assert.deepEqual(new GlobSearchTool().validateArgs({ pattern: '', relativePath: 1, maxResults: 0 }), [
        'pattern must be a non-empty string',
        'relativePath must be a string',
        'maxResults must be a positive number'
    ]);
    assert.deepEqual(new GrepSearchTool().validateArgs({ query: '', relativePath: 1, regex: 'yes', maxResults: -1 }), [
        'query must be a non-empty string',
        'relativePath must be a string',
        'regex must be a boolean',
        'maxResults must be a positive number'
    ]);
});

test('GlobSearchTool limits returned matches', async () => {
    await withSandbox(async root => {
        await fs.writeFile(path.join(root, 'a.md'), '# A');
        await fs.writeFile(path.join(root, 'b.md'), '# B');

        const result = await new GlobSearchTool().execute({ pattern: '*.md', maxResults: 1 });

        assert.equal(result.status, 'success');
        assert.equal((result.data as { matches: string[] }).matches.length, 1);
        assert.equal(result.metadata?.maxResults, 1);
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

test('GrepSearchTool limits returned matches', async () => {
    await withSandbox(async root => {
        await fs.writeFile(path.join(root, 'agent.md'), 'agent\nagent\nagent', 'utf-8');

        const result = await new GrepSearchTool().execute({ query: 'agent', maxResults: 2 });

        assert.equal(result.status, 'success');
        assert.equal((result.data as { matches: unknown[] }).matches.length, 2);
        assert.equal(result.metadata?.maxResults, 2);
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

test('GrepSearchTool returns an error for invalid regex patterns', async () => {
    await withSandbox(async () => {
        const result = await new GrepSearchTool().execute({ query: '[', regex: true });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /Invalid regular expression/);
    });
});

test('search tools return errors for paths outside the sandbox', async () => {
    await withSandbox(async () => {
        const result = await new GlobSearchTool().execute({ pattern: '**/*.md', relativePath: '..' });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /不在安全沙盒内/);
    });
});
