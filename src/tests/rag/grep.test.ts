import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { grepMatchesToSearchResults, grepNotes } from '../../rag/grep.js';

test('grepNotes searches supported knowledge files with line context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-grep-'));
    await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notes', 'agent.md'), [
        '# Agent',
        'loop memory tool',
        'policy observability'
    ].join('\n'));
    await fs.writeFile(path.join(dir, 'notes', 'binary.bin'), 'loop should be ignored');

    const matches = await grepNotes(path.join(dir, 'notes'), 'memory', { contextLines: 1 });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].source, 'agent.md');
    assert.equal(matches[0].line, 2);
    assert.deepEqual(matches[0].before, ['# Agent']);
    assert.deepEqual(matches[0].after, ['policy observability']);
});

test('grepMatchesToSearchResults adapts grep matches to eval scoring input', () => {
    const results = grepMatchesToSearchResults([{
        source: 'agent.md',
        line: 2,
        text: 'loop memory tool',
        before: ['# Agent'],
        after: ['policy observability']
    }], 'memory');

    assert.equal(results[0].source, 'agent.md');
    assert.equal(results[0].score, 1);
    assert.match(results[0].text, /loop memory tool/);
});
