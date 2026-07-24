import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSkillManifestPrompt, loadSkillManifests, readSkill } from '../skills.js';

test('skill manifest prompt does not include full skill body', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-skills-'));
    await fs.mkdir(path.join(tempDir, 'example'));
    await fs.writeFile(path.join(tempDir, 'example', 'SKILL.md'), [
        '---',
        'name: example-skill',
        'description: Use for example tasks.',
        '---',
        '',
        '# Example Skill',
        '',
        'FULL BODY SHOULD BE LAZY LOADED'
    ].join('\n'), 'utf-8');
    await fs.writeFile(path.join(tempDir, 'ignored.md'), 'flat Markdown files are not skills', 'utf-8');

    const manifests = await loadSkillManifests(tempDir);
    const prompt = buildSkillManifestPrompt(manifests);

    assert.equal(manifests.length, 1);
    assert.match(prompt, /example-skill/);
    assert.match(prompt, /Use for example tasks/);
    assert.doesNotMatch(prompt, /FULL BODY SHOULD BE LAZY LOADED/);
});

test('readSkill loads a single skill by manifest name', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-skills-'));
    await fs.mkdir(path.join(tempDir, 'example'));
    await fs.writeFile(path.join(tempDir, 'example', 'SKILL.md'), [
        '---',
        'name: example-skill',
        'description: Use for example tasks.',
        '---',
        '',
        '# Example Skill',
        '',
        'Load this body on demand.'
    ].join('\n'), 'utf-8');

    const skill = await readSkill('example-skill', tempDir);

    assert.equal(skill.name, 'example-skill');
    assert.equal(skill.fileName, 'example/SKILL.md');
    assert.match(skill.content, /Load this body on demand/);
});

test('loadSkillManifests rejects skills without required frontmatter metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-skills-'));
    await fs.mkdir(path.join(tempDir, 'invalid'));
    await fs.writeFile(path.join(tempDir, 'invalid', 'SKILL.md'), '# Missing metadata', 'utf-8');

    await assert.rejects(
        () => loadSkillManifests(tempDir),
        /frontmatter must define non-empty name and description/
    );
});

test('built-in wiki skills use current paths and respect tool boundaries', async () => {
    const [captureBadcase, ingestSource, lintWiki, noteCuration] = await Promise.all([
        readSkill('badcase'),
        readSkill('ingest'),
        readSkill('wiki-lint'),
        readSkill('note-curation')
    ]);

    assert.match(captureBadcase.content, /evaluation\/rag\/questions\.json/);
    assert.doesNotMatch(captureBadcase.content, /examples\/\*-eval/);
    assert.match(ingestSource.content, /配置的 `notes\/` 根目录/);
    assert.match(lintWiki.content, /默认将 lint 视为只读/);
    assert.equal(noteCuration.fileName, 'note-curation/SKILL.md');
    assert.match(noteCuration.content, /加载 `filesystem` tool group/);
});
