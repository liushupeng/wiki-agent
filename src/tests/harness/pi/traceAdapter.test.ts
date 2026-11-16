import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectAgentTraceMetrics, parseJsonlV2 } from '../../../evaluation/agent.js';
import { beginPiTraceRecorder } from '../../../harness/pi/traceAdapter.js';
import type { AgentConfig } from '../../../types.js';

test('beginPiTraceRecorder writes JSONL v2 spans for run, step, tool, and model', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-pi-trace-'));
    const config: AgentConfig = {
        modelName: 'test-model',
        temperature: 0,
        maxLoopSteps: 8,
        traceDir,
        telemetryBackend: 'file'
    };

    const recorder = await beginPiTraceRecorder(config, 'hello trace');
    assert.ok(recorder);
    assert.ok(recorder!.filePath);

    const handlers: Array<(event: Record<string, unknown>) => void> = [];
    const session = {
        subscribe(handler: (event: Record<string, unknown>) => void) {
            handlers.push(handler);
            return () => handlers.splice(handlers.indexOf(handler), 1);
        }
    };

    const unsubscribe = recorder!.attachSessionListeners(session as never);
    const emit = (event: Record<string, unknown>) => handlers.forEach(handler => handler(event));

    emit({ type: 'turn_start' });
    await recorder!.instrumentToolCall('search_notes', 'call-1', { query: 'x' }, 'rag', async () => ({
        status: 'success',
        data: { hits: [] }
    }));
    emit({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } }
    });
    emit({ type: 'turn_end' });

    await recorder!.finalize({
        terminationReason: 'completed',
        finalAnswerPolicy: {
            action: 'allow',
            reason: 'ok',
            content: 'answer',
            snapshot: {
                ragCallsUsed: 1,
                ragBudgetExhausted: false,
                inventoryState: 'sufficient' as const,
                evidenceCount: 1,
                distinctSources: 1,
                citedCount: 1,
                truncatedCount: 0,
                conflictedCount: 0,
                lowAuthorityCount: 0
            }
        },
        evidence: {
            ragCallsUsed: 1,
            ragBudgetExhausted: false,
            inventoryState: 'sufficient',
            evidenceCount: 1,
            distinctSources: 1,
            citedCount: 1,
            truncatedCount: 0,
            conflictedCount: 0,
            lowAuthorityCount: 0
        },
        stepCount: Math.max(1, recorder!.getStepCount())
    });
    unsubscribe();

    const content = await fs.readFile(recorder!.filePath!, 'utf-8');
    const records = parseJsonlV2(content);
    const metrics = collectAgentTraceMetrics(records);

    assert.equal(metrics.stepCount, 1);
    assert.equal(metrics.terminationReason, 'completed');
    assert.ok(records.some(record => record.name === 'wiki_agent.run'));
    assert.ok(records.some(record => record.name === 'wiki_agent.step.1'));
    assert.ok(records.some(record => record.name === 'tool.execute'));
    assert.ok(records.some(record => record.name === 'gen_ai.chat'));
    assert.ok(records.some(record => record.name === 'final_answer.policy'));
    assert.equal(recorder!.getStepCount(), 1);
});

test('beginPiTraceRecorder returns undefined when tracing is disabled', async () => {
    const recorder = await beginPiTraceRecorder({ modelName: 'm', temperature: 0, maxLoopSteps: 1 }, 'noop');
    assert.equal(recorder, undefined);
});
