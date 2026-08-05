import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePositiveInteger } from '../../utils/number.js';

test('parsePositiveInteger accepts positive integers and applies an upper bound', () => {
    assert.equal(parsePositiveInteger('12', 100), 12);
    assert.equal(parsePositiveInteger('101', 100), 100);
});

test('parsePositiveInteger rejects missing, non-integer, and non-positive values', () => {
    assert.equal(parsePositiveInteger(undefined, 100), undefined);
    assert.equal(parsePositiveInteger('0', 100), undefined);
    assert.equal(parsePositiveInteger('-1', 100), undefined);
    assert.equal(parsePositiveInteger('1.5', 100), undefined);
    assert.equal(parsePositiveInteger('abc', 100), undefined);
});
