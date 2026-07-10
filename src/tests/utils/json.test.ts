import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonForTrace, parseJsonSafely, parseToolArguments } from '../../utils/json.js';

test('parseJsonSafely returns parsed value for valid JSON', () => {
    const result = parseJsonSafely('{"value":"ok"}');

    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(result.value, { value: 'ok' });
    }
});

test('parseJsonSafely returns an error for invalid JSON', () => {
    const result = parseJsonSafely('{invalid');

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /property name|JSON/i);
    }
});

test('parseToolArguments treats empty arguments as an empty object', () => {
    const result = parseToolArguments('');

    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(result.value, {});
    }
});

test('parseJsonForTrace preserves invalid input as a readable marker', () => {
    const result = parseJsonForTrace('{invalid');

    assert.equal(result, 'invalid JSON: {invalid');
});
