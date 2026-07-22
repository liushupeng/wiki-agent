import assert from 'node:assert/strict';
import test from 'node:test';
import { WIKI_AGENT_SYSTEM_PROMPT } from '../../prompts/systemPrompt.js';

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
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /wiki 中已沉淀的结论/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /raw source 明确写到的内容/);
});

test('wiki-agent system prompt guides vector versus grep note search', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /search_notes 做语义检索/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /grep_notes 做关键词\/正则检索/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /maxResults<=10/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /不要对多个宽泛关键词连续 grep/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /自动按正则处理/);
});

test('wiki-agent system prompt keeps evidence reading scoped', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /read_note 必须优先带 query、titlePath 或较小 maxChunks/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /不要把整篇大文件读入上下文/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /related_notes/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /默认保持同目录范围/);
});

test('wiki-agent system prompt guides on-demand tool group loading', () => {
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /默认只暴露 core 工具/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /load_tool_group/);
    assert.match(WIKI_AGENT_SYSTEM_PROMPT, /下一轮规划/);
});
