import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolObservation } from '../../context/toolObservation.js';

test('buildToolObservation preserves results within the context budget', () => {
    const observation = buildToolObservation({
        status: 'success',
        data: { source: 'wiki/investing.md', text: 'short evidence' }
    }, 1_000);

    assert.equal(observation.truncated, false);
    assert.deepEqual(JSON.parse(observation.content), {
        status: 'success',
        data: { source: 'wiki/investing.md', text: 'short evidence' }
    });
});

test('buildToolObservation compacts large arrays and text into valid JSON', () => {
    const observation = buildToolObservation({
        status: 'success',
        data: {
            chunks: Array.from({ length: 10 }, (_, index) => ({
                source: `notes/${index}.md`,
                text: 'e'.repeat(2_000)
            }))
        }
    }, 5_000);
    const value = JSON.parse(observation.content) as {
        data: { chunks: Array<{ text: string } | string> };
        context: { truncated: boolean; originalChars: number };
    };

    assert.equal(observation.truncated, true);
    assert.ok(observation.contextChars <= 5_000);
    assert.equal(value.context.truncated, true);
    assert.equal(value.data.chunks.length, 6);
    assert.match((value.data.chunks[0] as { text: string }).text, /\[truncated\]$/);
});

test('buildToolObservation falls back to a bounded preview for oversized metadata', () => {
    const observation = buildToolObservation({
        status: 'execution_failed',
        error: 'connection refused',
        metadata: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'x'.repeat(2_000)]))
    }, 512);
    const value = JSON.parse(observation.content) as {
        status: string;
        context: { truncated: boolean };
    };

    assert.equal(value.status, 'execution_failed');
    assert.equal(value.context.truncated, true);
    assert.ok(observation.contextChars <= 512);
});
