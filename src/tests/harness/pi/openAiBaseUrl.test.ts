import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepSeekCompatibleHost, normalizeOpenAiCompatibleBaseUrl } from '../../../harness/pi/openAiBaseUrl.js';

test('normalizeOpenAiCompatibleBaseUrl appends /v1', () => {
    assert.equal(normalizeOpenAiCompatibleBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeOpenAiCompatibleBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
});

test('isDeepSeekCompatibleHost detects deepseek hosts', () => {
    assert.equal(isDeepSeekCompatibleHost('https://api.deepseek.com'), true);
    assert.equal(isDeepSeekCompatibleHost('https://example.com/v1'), false);
});
