import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const envModuleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'env.js')).href;

test('environment loader combines defaults and local overrides without replacing inherited variables', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-env-'));
    await fs.writeFile(path.join(directory, '.env.example'), 'DEFAULT_ONLY=default\nOVERRIDE=default\n', 'utf-8');
    await fs.writeFile(path.join(directory, '.env'), 'LOCAL_ONLY=local\nOVERRIDE=local\nINHERITED=local\n', 'utf-8');
    const result = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(envModuleUrl)}); console.log(JSON.stringify({
            defaultOnly: process.env.DEFAULT_ONLY,
            localOnly: process.env.LOCAL_ONLY,
            override: process.env.OVERRIDE,
            inherited: process.env.INHERITED
        }));`
    ], {
        cwd: directory,
        env: { PATH: process.env.PATH, INHERITED: 'process' },
        encoding: 'utf-8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        defaultOnly: 'default',
        localOnly: 'local',
        override: 'local',
        inherited: 'process'
    });
});
