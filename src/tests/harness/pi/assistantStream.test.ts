import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantStreamEmitter } from '../../../harness/pi/assistantStream.js';

test('createAssistantStreamEmitter forwards incremental deltas only', () => {
    const chunks: string[] = [];
    const emitter = createAssistantStreamEmitter(chunk => chunks.push(chunk));

    emitter.emit('hello');
    emitter.emit('hello world');
    emitter.emit('hello world');

    assert.deepEqual(chunks, ['hello', ' world']);
});

test('createAssistantStreamEmitter replaces non-prefix content with a leading newline', () => {
    const chunks: string[] = [];
    const emitter = createAssistantStreamEmitter(chunk => chunks.push(chunk));

    emitter.emit('draft answer');
    emitter.emit('final abstention text');

    assert.deepEqual(chunks, ['draft answer', '\nfinal abstention text']);
});
