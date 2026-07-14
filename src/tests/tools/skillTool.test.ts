import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LoadSkillTool } from '../../tools/skillTool.js';

test('LoadSkillTool validates required skill name', () => {
    const tool = new LoadSkillTool();

    assert.deepEqual(tool.validateArgs({}), ['name must be a non-empty string']);
    assert.deepEqual(tool.validateArgs({ name: 'example-skill' }), []);
});

test('LoadSkillTool loads a skill by manifest name', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-skill-tool-'));
    const previousSkillsDir = process.env.SKILLS_DIR;
    process.env.SKILLS_DIR = tempDir;

    try {
        await fs.writeFile(path.join(tempDir, 'example.md'), [
            '---',
            'name: example-skill',
            'description: Use for example tasks.',
            '---',
            '',
            '# Example Skill',
            '',
            'Skill body loaded by tool.'
        ].join('\n'), 'utf-8');

        const result = await new LoadSkillTool().execute({ name: 'example-skill' });

        assert.equal(result.status, 'success');
        assert.equal((result.data as { name: string }).name, 'example-skill');
        assert.match((result.data as { content: string }).content, /Skill body loaded by tool/);
    } finally {
        restoreEnv('SKILLS_DIR', previousSkillsDir);
    }
});

test('LoadSkillTool returns a helpful error when the skill is missing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-skill-tool-'));
    const previousSkillsDir = process.env.SKILLS_DIR;
    process.env.SKILLS_DIR = tempDir;

    try {
        const result = await new LoadSkillTool().execute({ name: 'missing-skill' });

        assert.equal(result.status, 'error');
        assert.match(result.error ?? '', /skill not found/);
        assert.match(String(result.metadata?.hint), /skill manifest/);
    } finally {
        restoreEnv('SKILLS_DIR', previousSkillsDir);
    }
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
