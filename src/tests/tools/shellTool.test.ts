import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShellExecuteTool } from '../../tools/shellTool.js';

async function withSandbox<T>(run: (root: string) => Promise<T>): Promise<T> {
    const previousRoot = process.env.AGENT_SANDBOX_ROOT;
    const previousOutputMax = process.env.TOOL_OUTPUT_MAX_CHARS;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-shell-tool-'));
    process.env.AGENT_SANDBOX_ROOT = root;

    try {
        return await run(root);
    } finally {
        restoreEnv('AGENT_SANDBOX_ROOT', previousRoot);
        restoreEnv('TOOL_OUTPUT_MAX_CHARS', previousOutputMax);
    }
}

test('ShellExecuteTool runs commands in the runtime sandbox', async () => {
    await withSandbox(async root => {
        const result = await new ShellExecuteTool().execute({ command: 'node -e "console.log(process.cwd())"' });

        assert.equal(result.status, 'success');
        assert.equal((result.data as { stdout: string }).stdout, path.resolve(root));
        assert.equal(result.metadata?.cwd, path.resolve(root));
    });
});

test('ShellExecuteTool blocks forbidden shell tokens before execution', async () => {
    await withSandbox(async () => {
        const result = await new ShellExecuteTool().execute({ command: 'rm file.txt' });

        assert.equal(result.status, 'security_error');
        assert.match(result.error ?? '', /forbidden shell token/);
    });
});

test('ShellExecuteTool truncates large stdout', async () => {
    await withSandbox(async () => {
        process.env.TOOL_OUTPUT_MAX_CHARS = '4';

        const result = await new ShellExecuteTool().execute({ command: 'node -e "console.log(\'abcdef\')"' });

        assert.equal(result.status, 'success');
        assert.equal(result.metadata?.stdoutTruncated, true);
        assert.match((result.data as { stdout: string }).stdout, /^abcd/);
        assert.match((result.data as { stdout: string }).stdout, /output truncated/);
    });
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
