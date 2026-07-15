import assert from 'node:assert/strict';
import test from 'node:test';
import { LoadToolGroupTool, resolveToolGroup, ToolExposureController } from '../../tools/exposure.js';
import { GitStatusTool } from '../../tools/codingTool.js';
import { SearchNotesTool } from '../../tools/ragTool.js';
import { ShellExecuteTool } from '../../tools/shellTool.js';

test('resolveToolGroup assigns tools to capability groups', () => {
    assert.equal(resolveToolGroup('search_notes'), 'core');
    assert.equal(resolveToolGroup('mcp_fs_read_text_file'), 'filesystem');
    assert.equal(resolveToolGroup('mcp_git_git_status'), 'git');
    assert.equal(resolveToolGroup('mcp_sqlite_read_query'), 'sqlite');
    assert.equal(resolveToolGroup('apply_patch'), 'coding');
    assert.equal(resolveToolGroup('execute_command'), 'shell');
});

test('ToolExposureController exposes core tools by default and activates groups on demand', async () => {
    const controller = new ToolExposureController();
    const loadToolGroup = new LoadToolGroupTool(controller);

    assert.equal(controller.shouldExpose(new SearchNotesTool()), true);
    assert.equal(controller.shouldExpose(new GitStatusTool()), false);
    assert.equal(controller.shouldExpose(new ShellExecuteTool()), false);

    const result = await loadToolGroup.execute({ group: 'git' });

    assert.equal(result.status, 'success');
    assert.equal(controller.shouldExpose(new GitStatusTool()), true);
    assert.equal(controller.shouldExpose(new ShellExecuteTool()), false);
});

test('ToolExposureController can reset active groups back to core', () => {
    const controller = new ToolExposureController();

    controller.activateGroup('git');
    controller.activateGroup('shell');
    controller.resetToCore();

    assert.deepEqual(controller.getActiveGroups(), ['core']);
    assert.equal(controller.shouldExpose(new GitStatusTool()), false);
    assert.equal(controller.shouldExpose(new SearchNotesTool()), true);
});

test('LoadToolGroupTool validates loadable group names', () => {
    const tool = new LoadToolGroupTool(new ToolExposureController());

    assert.deepEqual(tool.validateArgs({ group: 'git' }), []);
    assert.deepEqual(tool.validateArgs({ group: 'core' }), ['group must be one of: filesystem, git, sqlite, coding, shell']);
    assert.deepEqual(tool.validateArgs({ group: 'unknown' }), ['group must be one of: filesystem, git, sqlite, coding, shell']);
});
