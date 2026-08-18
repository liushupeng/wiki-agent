import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryManager } from '../../context/memory.js';
import {
    createMemoryProposal,
    transitionMemoryProposal
} from '../../context/memoryProposal.js';
import { verifyMemoryProposal } from '../../context/memoryVerifier.js';

test('MemoryProposal rejects illegal transitions and sensitive content', () => {
    const proposal = createMemoryProposal({
        content: 'api_key=super-secret-value',
        kind: 'fact',
        userRequest: '请记住这个',
        sourceMessageRefs: ['message-1']
    });
    assert.throws(() => transitionMemoryProposal(proposal, 'approved'), /illegal memory proposal transition/);
    const verified = verifyMemoryProposal(proposal, []);
    assert.equal(verified.status, 'rejected_verify');
    assert.match(verified.verification?.reasons.join(' ') ?? '', /敏感凭据/);
});

test('MemoryProposal requires explicit user intent and evidence for facts', () => {
    const proposal = createMemoryProposal({ content: '项目使用 SQLite', kind: 'fact' });
    const verified = verifyMemoryProposal(proposal, []);
    assert.equal(verified.status, 'rejected_verify');
    assert.equal(verified.verification?.reasons.length, 2);
});

test('approved proposal commits atomically and survives restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-proposal-'));
    const manager = new MemoryManager('system', { memoryDirectory: directory, sessionId: 'session-1' });
    const proposal = manager.proposeMemory({
        content: '用户偏好简体中文回答',
        kind: 'preference',
        userRequest: '请记住我偏好简体中文回答',
        sourceMessageRefs: ['message-1']
    });
    assert.equal(proposal.status, 'pending_approval');
    assert.equal(manager.getLongTermMemories().length, 0);

    const committed = manager.approveMemoryProposal(proposal.id);
    assert.equal(committed.status, 'committed');
    assert.equal(manager.getLongTermMemories()[0]?.content, '用户偏好简体中文回答');
    assert.throws(() => manager.approveMemoryProposal(proposal.id), /illegal memory proposal transition/);
    manager.close();

    const restored = new MemoryManager('system', { memoryDirectory: directory, sessionId: 'session-1' });
    assert.equal(restored.listMemoryProposals('committed')[0]?.id, proposal.id);
    assert.equal(restored.getLongTermMemories()[0]?.content, '用户偏好简体中文回答');
    restored.close();
});

test('user can reject only pending approval proposals', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-proposal-'));
    const manager = new MemoryManager('system', { memoryDirectory: directory });
    const proposal = manager.proposeMemory({
        content: '不要自动执行 shell',
        kind: 'constraint',
        userRequest: '请记住不要自动执行 shell',
        sourceMessageRefs: ['message-1']
    });
    assert.equal(manager.rejectMemoryProposal(proposal.id).status, 'rejected_user');
    assert.throws(() => manager.rejectMemoryProposal(proposal.id), /illegal memory proposal transition/);
    manager.close();
});
