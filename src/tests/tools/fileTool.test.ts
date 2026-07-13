import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ListDirTool, ReadFileTool, WriteFileTool } from '../../tools/fileTool.js';

async function withSandbox<T>(run: (root: string) => Promise<T>): Promise<T> {
    const previousRoot = process.env.AGENT_SANDBOX_ROOT;
    const previousMaxBytes = process.env.READ_FILE_MAX_BYTES;
    const previousOutputMax = process.env.TOOL_OUTPUT_MAX_CHARS;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-file-tool-'));
    process.env.AGENT_SANDBOX_ROOT = root;

    try {
        return await run(root);
    } finally {
        restoreEnv('AGENT_SANDBOX_ROOT', previousRoot);
        restoreEnv('READ_FILE_MAX_BYTES', previousMaxBytes);
        restoreEnv('TOOL_OUTPUT_MAX_CHARS', previousOutputMax);
    }
}

test('ListDirTool lists files and directories inside the runtime sandbox', async () => {
    await withSandbox(async root => {
        await fs.mkdir(path.join(root, 'notes'), { recursive: true });
        await fs.writeFile(path.join(root, 'readme.md'), '# Readme');

        const result = await new ListDirTool().execute({ relativePath: '.' });

        assert.equal(result.status, 'success');
        assert.deepEqual(result.data, [
            { name: 'notes', type: 'directory' },
            { name: 'readme.md', type: 'file' }
        ]);
        assert.equal(result.metadata?.count, 2);
    });
});

test('ReadFileTool reads and truncates files inside the runtime sandbox', async () => {
    await withSandbox(async root => {
        process.env.READ_FILE_MAX_BYTES = '5';
        process.env.TOOL_OUTPUT_MAX_CHARS = '100';
        await fs.writeFile(path.join(root, 'note.txt'), 'abcdefghi', 'utf-8');

        const result = await new ReadFileTool().execute({ filename: 'note.txt', maxBytes: 20 });

        assert.equal(result.status, 'success');
        assert.deepEqual(result.data, { filename: 'note.txt', content: 'abcde' });
        assert.equal(result.metadata?.sizeBytes, 9);
        assert.equal(result.metadata?.readBytes, 5);
        assert.equal(result.metadata?.truncated, true);
        assert.equal(result.metadata?.maxBytes, 5);
    });
});

test('WriteFileTool creates parent directories and writes content inside the runtime sandbox', async () => {
    await withSandbox(async root => {
        const result = await new WriteFileTool().execute({
            filename: 'output/result.txt',
            content: 'hello agent'
        });

        assert.equal(result.status, 'success');
        assert.equal(await fs.readFile(path.join(root, 'output', 'result.txt'), 'utf-8'), 'hello agent');
        assert.equal(result.metadata?.message, 'file written: output/result.txt');
    });
});

test('file tools return errors for paths outside the sandbox', async () => {
    await withSandbox(async () => {
        const readResult = await new ReadFileTool().execute({ filename: '../outside.txt' });
        const writeResult = await new WriteFileTool().execute({ filename: '../outside.txt', content: 'x' });

        assert.equal(readResult.status, 'error');
        assert.equal(writeResult.status, 'error');
        assert.match(readResult.error ?? '', /不在安全沙盒内/);
        assert.match(writeResult.error ?? '', /不在安全沙盒内/);
    });
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
