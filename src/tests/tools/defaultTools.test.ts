import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTools, getLocalToolNamesCoveredByMcp } from '../../tools/defaultTools.js';

test('createDefaultTools returns the CLI default tool set', () => {
    const toolNames = createDefaultTools().map(tool => tool.name);

    assert.deepEqual(toolNames, [
        'list_dir',
        'read_file',
        'write_file',
        'glob_search',
        'grep_search',
        'search_notes',
        'grep_notes',
        'read_note',
        'related_notes',
        'load_skill',
        'load_tool_group',
        'git_status',
        'git_diff',
        'apply_patch',
        'run_tests',
        'execute_command'
    ]);
});

test('createDefaultTools skips local tools covered by MCP tools', () => {
    const skipToolNames = getLocalToolNamesCoveredByMcp([
        { remoteToolName: 'read_text_file' },
        { remoteToolName: 'write_file' },
        { remoteToolName: 'list_directory' },
        { remoteToolName: 'search_files' },
        { remoteToolName: 'git_status' },
        { remoteToolName: 'git_diff_staged' }
    ]);
    const toolNames = createDefaultTools({ skipToolNames }).map(tool => tool.name);

    assert.equal(toolNames.includes('read_file'), false);
    assert.equal(toolNames.includes('write_file'), false);
    assert.equal(toolNames.includes('list_dir'), false);
    assert.equal(toolNames.includes('glob_search'), false);
    assert.equal(toolNames.includes('git_status'), false);
    assert.equal(toolNames.includes('git_diff'), false);

    assert.equal(toolNames.includes('grep_search'), true);
    assert.equal(toolNames.includes('grep_notes'), true);
    assert.equal(toolNames.includes('search_notes'), true);
    assert.equal(toolNames.includes('apply_patch'), true);
    assert.equal(toolNames.includes('run_tests'), true);
});
