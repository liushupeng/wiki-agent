import assert from 'node:assert/strict';
import test from 'node:test';
import { limitText } from '../limits.js';

test('limitText truncates oversized tool output', () => {
    const result = limitText('abcdef', 3);

    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, 6);
    assert.match(result.text, /^abc/);
});
