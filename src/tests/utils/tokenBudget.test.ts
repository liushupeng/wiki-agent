import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateJsonSize, estimateMessagesSize, estimateTextSize, estimateToolSchemasSize } from '../../utils/tokenBudget.js';

test('estimateTextSize estimates chars and approximate tokens', () => {
    assert.deepEqual(estimateTextSize('abcdefgh'), {
        chars: 8,
        approxTokens: 2
    });
    assert.deepEqual(estimateTextSize('abcde'), {
        chars: 5,
        approxTokens: 2
    });
});

test('estimateJsonSize estimates serialized JSON size', () => {
    const estimate = estimateJsonSize({ value: 'ok' });

    assert.equal(estimate.chars, JSON.stringify({ value: 'ok' }).length);
    assert.equal(estimate.approxTokens, Math.ceil(estimate.chars / 4));
});

test('estimateMessagesSize and estimateToolSchemasSize use serialized payload size', () => {
    const messageEstimate = estimateMessagesSize([{ role: 'user', content: 'hello' }]);
    const schemaEstimate = estimateToolSchemasSize([{
        type: 'function',
        function: {
            name: 'test_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} }
        }
    }]);

    assert.ok(messageEstimate.chars > 0);
    assert.ok(messageEstimate.approxTokens > 0);
    assert.ok(schemaEstimate.chars > messageEstimate.chars);
});
