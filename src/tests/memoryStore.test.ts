import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryManager } from '../context/memory.js';
import { MemoryStore } from '../context/memoryStore.js';

test('MemoryManager restores session messages and explicit long-term memories', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-memory-'));
    const sessionId = 'session-restore';
    const memory = new MemoryManager('system', { memoryDirectory: directory, sessionId });

    memory.append({ role: 'user', content: '我偏好中文回答。' });
    memory.append({ role: 'assistant', content: '好的。' });
    memory.remember('用户偏好中文回答。', 'preference');
    memory.close();

    const restored = new MemoryManager('system', { memoryDirectory: directory, sessionId });
    const messages = restored.getMessages();

    assert.equal(restored.resumedSession, true);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'system');
    assert.match(String(messages[1].content), /用户偏好中文回答/);
    assert.deepEqual(messages.slice(2), [
        { role: 'user', content: '我偏好中文回答。' },
        { role: 'assistant', content: '好的。' }
    ]);
    assert.equal(restored.getLongTermMemories()[0]?.kind, 'preference');
    restored.close();
});

test('MemoryManager clears persisted sessions without deleting long-term memory', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-memory-'));
    const memory = new MemoryManager('system', { memoryDirectory: directory, sessionId: 'session-a' });

    memory.append({ role: 'user', content: 'temporary question' });
    const longTermMemory = memory.remember('长期约束', 'constraint');
    memory.clear();

    const messages = memory.getMessages();
    assert.equal(messages.length, 2);
    assert.match(String(messages[1].content), /长期约束/);
    assert.equal(memory.forget(longTermMemory.id), true);
    assert.deepEqual(memory.getLongTermMemories(), []);
    memory.close();

    const restored = new MemoryManager('system', { memoryDirectory: directory, sessionId: 'session-a' });
    assert.deepEqual(restored.getMessages(), [{ role: 'system', content: 'system' }]);
    restored.close();
});

test('MemoryStore writes readable daily journals and prunes old sessions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-memory-'));
    let currentTime = new Date('2026-07-01T12:00:00.000Z');
    const store = new MemoryStore(directory, () => currentTime);

    store.ensureSession('old-session');
    store.appendSessionMessage('old-session', { role: 'user', content: 'old message' });
    currentTime = new Date('2026-07-10T12:00:00.000Z');
    store.prune({ sessionRetentionDays: 7, journalRetentionDays: 90 });

    assert.equal(store.hasSession('old-session'), false);
    const journal = await fs.readFile(path.join(directory, 'journals', '2026-07-01.md'), 'utf-8');
    assert.match(journal, /old message/);
    store.close();
});

test('MemoryStore lists recent sessions with previews and returns deterministic overviews', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-memory-'));
    let currentTime = new Date('2026-07-01T12:00:00.000Z');
    const store = new MemoryStore(directory, () => currentTime);

    store.appendSessionMessage('older', { role: 'user', content: '第一个会话的问题' });
    store.appendSessionMessage('older', { role: 'assistant', content: '第一个会话的回答' });
    currentTime = new Date('2026-07-02T12:00:00.000Z');
    store.appendSessionMessage('recent', { role: 'user', content: '最近会话的问题' });
    store.appendSessionMessage('recent', { role: 'assistant', content: '最近会话的回答' });

    assert.deepEqual(store.listSessions(20, 9), [
        {
            id: 'recent',
            createdAt: '2026-07-02T12:00:00.000Z',
            updatedAt: '2026-07-02T12:00:00.000Z',
            messageCount: 2,
            preview: '用户：最近会话的问...'
        },
        {
            id: 'older',
            createdAt: '2026-07-01T12:00:00.000Z',
            updatedAt: '2026-07-01T12:00:00.000Z',
            messageCount: 2,
            preview: '用户：第一个会话的...'
        }
    ]);
    assert.deepEqual(store.getSessionOverview('recent', 100), {
        id: 'recent',
        createdAt: '2026-07-02T12:00:00.000Z',
        updatedAt: '2026-07-02T12:00:00.000Z',
        messageCount: 2,
        preview: '用户：最近会话的问题 助手：最近会话的回答',
        firstUserMessage: '最近会话的问题',
        lastUserMessage: '最近会话的问题',
        lastAssistantMessage: '最近会话的回答'
    });
    assert.equal(store.getSessionOverview('missing'), undefined);
    store.close();
});
