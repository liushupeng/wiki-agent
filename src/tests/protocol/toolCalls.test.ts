import assert from 'node:assert/strict';
import test from 'node:test';
import { appendToolCallDeltas, buildSkippedToolResult, buildToolCalls, isFunctionToolCall } from '../../protocol/toolCalls.js';

test('appendToolCallDeltas assembles streamed function arguments', () => {
    const buffer: Parameters<typeof buildToolCalls>[0] = [];

    appendToolCallDeltas(buffer, [{
        index: 0,
        id: 'call_1',
        function: { name: 'search_notes', arguments: '{"query"' }
    }]);
    appendToolCallDeltas(buffer, [{
        index: 0,
        function: { arguments: ':"agent"}' }
    }]);

    const toolCalls = buildToolCalls(buffer);

    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].id, 'call_1');
    assert.equal(toolCalls[0].function.name, 'search_notes');
    assert.equal(toolCalls[0].function.arguments, '{"query":"agent"}');
    assert.equal(isFunctionToolCall(toolCalls[0]), true);
});

test('buildSkippedToolResult creates an unsupported tool observation', () => {
    const result = buildSkippedToolResult({ id: 'call_custom', type: 'custom' }, 2);
    const content = JSON.parse(result.toolMessage.content as string);

    assert.equal(result.originalIndex, 2);
    assert.equal(result.toolMessage.role, 'tool');
    assert.equal(result.toolMessage.tool_call_id, 'call_custom');
    assert.equal(content.status, 'error');
    assert.equal(content.error, 'unsupported_tool_call_type');
    assert.equal(content.metadata.type, 'custom');
});
