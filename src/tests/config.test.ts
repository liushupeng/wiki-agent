import assert from 'node:assert/strict';
import test from 'node:test';
import { getApprovalMode } from '../config.js';

test('getApprovalMode defaults to prompt', () => {
    assert.equal(getApprovalMode({}), 'prompt');
});

test('getApprovalMode accepts explicit approval modes', () => {
    assert.equal(getApprovalMode({ APPROVAL_MODE: 'auto' }), 'auto');
    assert.equal(getApprovalMode({ APPROVAL_MODE: 'deny' }), 'deny');
});

test('getApprovalMode falls back to prompt for invalid values', () => {
    assert.equal(getApprovalMode({ APPROVAL_MODE: 'invalid' }), 'prompt');
});

