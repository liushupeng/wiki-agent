import assert from 'node:assert/strict';
import test from 'node:test';
import { WIKI_AGENT_SYSTEM_PROMPT } from '../prompts/systemPrompt.js';

test('wiki-agent system prompt includes skill lazy loading guidance', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /load_skill/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /skill manifest/);
});

test('wiki-agent system prompt discourages unnecessary tool calls and hidden reasoning output', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /不要过度调用工具/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /不输出冗长思考链/);
});

test('wiki-agent system prompt requires evidence-aware answers', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /不要编造不存在的笔记内容/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /笔记中明确写到的内容/);
});
