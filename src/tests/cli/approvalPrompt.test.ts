import assert from 'node:assert/strict';
import test from 'node:test';
import { askToolApproval, QuestionPrompt } from '../../cli/approvalPrompt.js';

test('askToolApproval accepts y and yes answers', async () => {
    await withConsoleSilenced(async () => {
        assert.equal(await askToolApproval(createPrompt('y'), approvalRequest()), true);
        assert.equal(await askToolApproval(createPrompt('yes'), approvalRequest()), true);
    });
});

test('askToolApproval rejects empty and negative answers', async () => {
    await withConsoleSilenced(async () => {
        assert.equal(await askToolApproval(createPrompt(''), approvalRequest()), false);
        assert.equal(await askToolApproval(createPrompt('no'), approvalRequest()), false);
    });
});

test('askToolApproval asks with the expected confirmation prompt', async () => {
    let query = '';
    const prompt: QuestionPrompt = {
        async question(value: string): Promise<string> {
            query = value;
            return 'y';
        }
    };

    await withConsoleSilenced(() => askToolApproval(prompt, approvalRequest()));

    assert.equal(query, 'Approve tool execution? [y/N] ');
});

function createPrompt(answer: string): QuestionPrompt {
    return {
        async question(): Promise<string> {
            return answer;
        }
    };
}

function approvalRequest() {
    return {
        toolName: 'write_file',
        riskLevel: 'write' as const,
        reason: 'writes to disk',
        args: { path: 'note.md' }
    };
}

async function withConsoleSilenced<T>(run: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        return await run();
    } finally {
        console.log = originalLog;
    }
}
