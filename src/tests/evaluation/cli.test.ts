import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentEvalArgs, parseRecallEvalArgs } from '../../evaluation/cli.js';

test('parseRecallEvalArgs defaults and separates variant from retriever', () => {
    assert.deepEqual(parseRecallEvalArgs([]), { variant: 'both', retriever: 'vector' });
    assert.deepEqual(
        parseRecallEvalArgs(['--', 'custom-questions.json', '--variant', 'raw-wiki', '--retriever', 'grep']),
        { questionsFile: 'custom-questions.json', variant: 'raw-wiki', retriever: 'grep' }
    );
    assert.throws(() => parseRecallEvalArgs(['--mode', 'both']), /usage:/);
    assert.throws(() => parseRecallEvalArgs(['--retriever', 'invalid']), /unsupported retriever/);
});

test('parseAgentEvalArgs supports deterministic samples or explicit IDs', () => {
    assert.deepEqual(parseAgentEvalArgs([]), { variant: 'both' });
    assert.deepEqual(
        parseAgentEvalArgs(['questions.json', '--variant', 'raw-only', '--random-count', '3', '--seed', 'baseline-1']),
        { questionsFile: 'questions.json', variant: 'raw-only', randomCount: 3, seed: 'baseline-1' }
    );
    assert.deepEqual(
        parseAgentEvalArgs(['--question-ids', 'investment-pillars, raft-components']),
        { variant: 'both', questionIds: ['investment-pillars', 'raft-components'] }
    );
});

test('parseAgentEvalArgs rejects ambiguous question selection', () => {
    assert.throws(
        () => parseAgentEvalArgs(['--random-count', '3', '--question-ids', 'one,two']),
        /--random-count and --question-ids cannot be used together/
    );
    assert.throws(() => parseAgentEvalArgs(['--seed', 'baseline']), /--seed requires --random-count/);
    assert.throws(() => parseAgentEvalArgs(['--question-ids', 'one,one']), /without duplicates/);
    assert.throws(() => parseAgentEvalArgs(['--random-count', '0']), /positive integer/);
});
