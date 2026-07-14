import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTools } from '../../tools/defaultTools.js';

test('createDefaultTools returns the CLI default tool set', () => {
    const toolNames = createDefaultTools().map(tool => tool.name);

    assert.deepEqual(toolNames, [
        'list_dir',
        'read_file',
        'write_file',
        'glob_search',
        'grep_search',
        'search_notes',
        'read_note',
        'related_notes',
        'load_skill',
        'git_status',
        'git_diff',
        'apply_patch',
        'run_tests',
        'execute_command'
    ]);
});
