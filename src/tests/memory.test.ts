import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { MemoryManager } from '../memory.js';

test('MemoryManager initializes with system prompt and protects internal history', () => {
    const memory = new MemoryManager('  system prompt  ');
    const messages = memory.getMessages();

    assert.deepEqual(messages, [{ role: 'system', content: 'system prompt' }]);

    messages.push({ role: 'user', content: 'external mutation' });
    assert.equal(memory.getMessages().length, 1);
});

test('MemoryManager appends non-empty messages and ignores empty messages', () => {
    const memory = new MemoryManager('system');

    memory.append({ role: 'user', content: 'hello' });
    memory.append({ role: 'assistant', content: null });

    const messages = memory.getMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, 'user');
});

test('MemoryManager clear keeps only the system prompt', () => {
    const memory = new MemoryManager('system');
    memory.append({ role: 'user', content: 'hello' });
    memory.append({ role: 'assistant', content: 'answer' });

    memory.clear();

    assert.deepEqual(memory.getMessages(), [{ role: 'system', content: 'system' }]);
});

test('MemoryManager getRoundCount counts user messages only', () => {
    const memory = new MemoryManager('system');
    memory.append({ role: 'user', content: 'first' });
    memory.append({ role: 'assistant', content: 'answer' });
    memory.append({ role: 'user', content: 'second' });

    assert.equal(memory.getRoundCount(), 2);
});

test('MemoryManager compacts old messages when message count exceeds the limit', () => {
    const memory = new MemoryManager('system', { maxHistoryMessages: 4, keepRecentMessages: 2 });

    memory.append({ role: 'user', content: 'old question' });
    memory.append({ role: 'assistant', content: 'old answer' });
    memory.append({ role: 'user', content: 'recent question' });
    memory.append({ role: 'assistant', content: 'recent answer' });

    const messages = memory.getMessages();

    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'system');
    assert.match(String(messages[1].content), /自动压缩摘要/);
    assert.match(String(messages[1].content), /old question/);
    assert.deepEqual(messages.slice(2), [
        { role: 'user', content: 'recent question' },
        { role: 'assistant', content: 'recent answer' }
    ]);
});

test('MemoryManager rolls older short-term messages into mid-term summary', () => {
    const memory = new MemoryManager('system', { maxHistoryMessages: 4, keepRecentMessages: 2 });

    memory.append({ role: 'user', content: 'question one' });
    memory.append({ role: 'assistant', content: 'answer one' });
    memory.append({ role: 'user', content: 'question two' });
    memory.append({ role: 'assistant', content: 'answer two' });
    memory.append({ role: 'user', content: 'question three' });
    memory.append({ role: 'assistant', content: 'answer three' });

    const messages = memory.getMessages();
    const midTermSummary = String(messages[1].content);

    assert.equal(messages[0].role, 'system');
    assert.match(midTermSummary, /question one/);
    assert.match(midTermSummary, /answer one/);
    assert.match(midTermSummary, /question two/);
    assert.match(midTermSummary, /answer two/);
    assert.deepEqual(messages.slice(2), [
        { role: 'user', content: 'question three' },
        { role: 'assistant', content: 'answer three' }
    ]);
});

test('MemoryManager clear removes mid-term summary and short-term messages', () => {
    const memory = new MemoryManager('system', { maxHistoryMessages: 4, keepRecentMessages: 2 });

    memory.append({ role: 'user', content: 'old question' });
    memory.append({ role: 'assistant', content: 'old answer' });
    memory.append({ role: 'user', content: 'recent question' });
    memory.append({ role: 'assistant', content: 'recent answer' });

    assert.equal(memory.getMessages().length, 4);

    memory.clear();

    assert.deepEqual(memory.getMessages(), [{ role: 'system', content: 'system' }]);
});

test('MemoryManager compaction keeps assistant tool_calls before retained tool messages', () => {
    const memory = new MemoryManager('system', { maxHistoryMessages: 4, keepRecentMessages: 1 });
    const assistantToolCall: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search_notes', arguments: '{"query":"agent"}' }
        }]
    };
    const toolMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"status":"success"}'
    };

    memory.append({ role: 'user', content: 'old question' });
    memory.append({ role: 'assistant', content: 'old answer' });
    memory.append(assistantToolCall);
    memory.append(toolMessage);

    const messages = memory.getMessages();
    const retained = messages.slice(2);

    assert.equal(retained[0].role, 'assistant');
    assert.equal(retained[1].role, 'tool');
});
