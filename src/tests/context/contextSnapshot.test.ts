import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { buildContextSnapshot, renderContextSnapshots } from '../../context/contextSnapshot.js';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

test('ContextSnapshot preserves goals, call ids, evidence, failures, and incomplete calls', () => {
    const messages: Message[] = [
        { role: 'user', content: `分析系统架构${'很长'.repeat(200)}` },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'call-ok', type: 'function', function: { name: 'search_notes', arguments: '{}' } },
                { id: 'call-pending', type: 'function', function: { name: 'read_note', arguments: '{}' } }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call-ok',
            content: JSON.stringify({ status: 'runtime_error', error: 'index unavailable' })
        }
    ];
    const snapshot = buildContextSnapshot({
        messages,
        evidence: [{
            id: 'e1',
            toolName: 'search_notes',
            source: 'wiki/architecture.md',
            chunkId: 'chunk-1',
            citation: 'wiki/architecture.md > Harness',
            truncated: true,
            observedAt: '2026-01-01T00:00:00.000Z'
        }],
        trajectorySteps: [{ step: 1, outcome: 'continue' }],
        now: () => new Date('2026-01-01T00:00:00.000Z')
    });

    assert.equal(snapshot.goals[0].endsWith('…'), true);
    assert.equal(snapshot.toolCalls[0]?.callId, 'call-ok');
    assert.equal(snapshot.failedAttempts[0]?.includes('index unavailable'), true);
    assert.equal(snapshot.incompleteItems[0]?.includes('call-pending'), true);
    assert.equal(snapshot.evidenceReferences[0]?.chunkId, 'chunk-1');
    assert.equal(snapshot.compression.deterministic, true);
    assert.match(renderContextSnapshots([snapshot]), /重新读取/);
});

test('ContextSnapshot keeps only latest unique items under budget', () => {
    const snapshot = buildContextSnapshot({
        messages: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
            { role: 'user', content: 'second' }
        ],
        budget: { maxGoals: 1 },
        now: () => new Date('2026-01-01T00:00:00.000Z')
    });
    assert.deepEqual(snapshot.goals, ['second']);
});
