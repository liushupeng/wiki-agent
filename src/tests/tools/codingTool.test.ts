import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ApplyPatchTool, GitDiffTool, GitStatusTool, getWorkspaceRoot, RunTestsTool } from '../../tools/codingTool.js';

const execFileAsync = promisify(execFile);

async function withWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
    const previousRoot = process.env.AGENT_WORKSPACE_ROOT;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-coding-tool-'));
    process.env.AGENT_WORKSPACE_ROOT = root;

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

test('getWorkspaceRoot reads AGENT_WORKSPACE_ROOT at runtime', async () => {
    await withWorkspace(async root => {
        assert.equal(getWorkspaceRoot(), path.resolve(root));
    });
});

test('ApplyPatchTool replaces text inside the runtime workspace', async () => {
    await withWorkspace(async root => {
        const filePath = path.join(root, 'note.txt');
        await fs.writeFile(filePath, 'hello world', 'utf-8');

        const result = await new ApplyPatchTool().execute({
            filePath: 'note.txt',
            oldText: 'world',
            newText: 'agent'
        });

        assert.equal(result.status, 'success');
        assert.equal(await fs.readFile(filePath, 'utf-8'), 'hello agent');
    });
});

test('ApplyPatchTool rejects paths outside the runtime workspace', async () => {
    await withWorkspace(async () => {
        const result = await new ApplyPatchTool().execute({
            filePath: '../outside.txt',
            oldText: 'a',
            newText: 'b'
        });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /outside workspace/);
    });
});

test('ApplyPatchTool requires oldText to match exactly once', async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, 'note.txt'), 'same same', 'utf-8');

        const result = await new ApplyPatchTool().execute({
            filePath: 'note.txt',
            oldText: 'same',
            newText: 'changed'
        });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /exactly once/);
    });
});

test('GitStatusTool and GitDiffTool run inside the runtime workspace', async () => {
    await withWorkspace(async root => {
        await execFileAsync('git', ['init'], { cwd: root });
        await fs.writeFile(path.join(root, 'note.txt'), 'initial\n', 'utf-8');

        const statusResult = await new GitStatusTool().execute();
        const diffResult = await new GitDiffTool().execute({ statOnly: true });

        assert.equal(statusResult.status, 'success');
        assert.equal(diffResult.status, 'success');
        assert.match((statusResult.data as { stdout: string }).stdout, /note\.txt/);
        assert.equal((diffResult.metadata as { workspaceRoot: string }).workspaceRoot, path.resolve(root));
    });
});

test('RunTestsTool runs a command inside the runtime workspace', async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, 'script.js'), 'console.log("ok from workspace")', 'utf-8');

        const result = await new RunTestsTool().execute({
            command: 'node script.js',
            timeoutMs: 5000
        });

        assert.equal(result.status, 'success');
        assert.match((result.data as { stdout: string }).stdout, /ok from workspace/);
    });
});

