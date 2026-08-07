import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentEvalArgs, parseAgentEvalCommand, parseRecallEvalArgs, parseRecallEvalCommand } from '../../evaluation/cli.js';
import { parseIndexKnowledgeCommand } from '../../rag/indexCli.js';

test('CLI command guards return help without executing work', () => {
    assert.deepEqual(parseIndexKnowledgeCommand([]), { action: 'help' });
    assert.deepEqual(parseIndexKnowledgeCommand(['--']), { action: 'help' });
    assert.deepEqual(parseIndexKnowledgeCommand(['--help']), { action: 'help' });
    assert.deepEqual(parseRecallEvalCommand([]), { action: 'help' });
    assert.deepEqual(parseRecallEvalCommand(['--help']), { action: 'help' });
    assert.deepEqual(parseAgentEvalCommand([]), { action: 'help' });
    assert.deepEqual(parseAgentEvalCommand(['--help']), { action: 'help' });
});

test('CLI command parsers require explicit execution intent', () => {
    assert.deepEqual(
        parseIndexKnowledgeCommand(['--', '--profile', 'tf-v1']),
        { action: 'run', args: { profileId: 'tf-v1' } }
    );
    assert.deepEqual(
        parseRecallEvalCommand(['--variant', 'both', '--retriever', 'grep']),
        { action: 'run', args: { profile: 'bm25-v1', variant: 'both', retriever: 'grep' } }
    );
    assert.deepEqual(
        parseAgentEvalCommand(['--variant', 'both', '--random-count', '3', '--seed', '20260805']),
        { action: 'run', args: { profile: 'bm25-v1', variant: 'both', randomCount: 3, seed: '20260805' } }
    );
    assert.throws(() => parseIndexKnowledgeCommand(['--variant', 'raw-only']), /--profile is required/);
    assert.throws(() => parseAgentEvalCommand(['--variant', 'both']), /choose --all/);
    assert.deepEqual(
        parseAgentEvalCommand(['--all']),
        { action: 'run', args: { profile: 'bm25-v1', variant: 'both' } }
    );
});

test('parseRecallEvalArgs defaults and separates variant from retriever', () => {
    assert.deepEqual(parseRecallEvalArgs([]), { profile: 'bm25-v1', variant: 'both', retriever: 'vector' });
    assert.deepEqual(
        parseRecallEvalArgs(['--', 'custom-questions.json', '--profile', 'bm25-v1', '--variant', 'raw-wiki', '--retriever', 'grep']),
        { questionsFile: 'custom-questions.json', profile: 'bm25-v1', variant: 'raw-wiki', retriever: 'grep' }
    );
    assert.deepEqual(
        parseRecallEvalArgs(['--wiki-first', 'false']),
        { profile: 'bm25-v1', variant: 'both', retriever: 'vector', wikiFirst: false }
    );
    assert.throws(() => parseRecallEvalArgs(['--mode', 'both']), /usage:/);
    assert.throws(() => parseRecallEvalArgs(['--retriever', 'invalid']), /unsupported retriever/);
    assert.throws(() => parseRecallEvalArgs(['--wiki-first', 'sometimes']), /must be true or false/);
});

test('parseAgentEvalArgs supports deterministic samples or explicit IDs', () => {
    assert.deepEqual(
        parseAgentEvalArgs(['questions.json', '--profile', 'bm25-v1', '--variant', 'raw-only', '--random-count', '3', '--seed', 'baseline-1']),
        { questionsFile: 'questions.json', profile: 'bm25-v1', variant: 'raw-only', randomCount: 3, seed: 'baseline-1' }
    );
    assert.deepEqual(
        parseAgentEvalArgs(['--question-ids', 'investment-pillars, raft-components']),
        { profile: 'bm25-v1', variant: 'both', questionIds: ['investment-pillars', 'raft-components'] }
    );
});

test('parseAgentEvalArgs rejects ambiguous question selection', () => {
    assert.throws(
        () => parseAgentEvalArgs(['--random-count', '3', '--question-ids', 'one,two']),
        /--all, --random-count, and --question-ids cannot be used together/
    );
    assert.throws(() => parseAgentEvalArgs(['--seed', 'baseline']), /--seed requires --random-count/);
    assert.throws(() => parseAgentEvalArgs(['--question-ids', 'one,one']), /without duplicates/);
    assert.throws(() => parseAgentEvalArgs(['--random-count', '0']), /positive integer/);
});
