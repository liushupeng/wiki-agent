import assert from 'node:assert/strict';
import test from 'node:test';
import { getKnowledgeSourceRoots, isWikiSource, parseKnowledgeSourceRoots, sourceWithPrefix } from '../../rag/sourceRoots.js';

test('parseKnowledgeSourceRoots parses prefixed source roots', () => {
    assert.deepEqual(parseKnowledgeSourceRoots('wiki=wiki;raw=notes/raw'), [
        { prefix: 'wiki', root: 'wiki' },
        { prefix: 'raw', root: 'notes/raw' }
    ]);
});

test('parseKnowledgeSourceRoots derives a prefix for bare roots', () => {
    assert.deepEqual(parseKnowledgeSourceRoots('notes'), [
        { prefix: 'notes', root: 'notes' }
    ]);
});

test('getKnowledgeSourceRoots falls back to NOTES_ROOT', () => {
    assert.deepEqual(getKnowledgeSourceRoots({ NOTES_ROOT: 'notes' }), [
        { prefix: 'notes', root: 'notes' }
    ]);
});

test('sourceWithPrefix normalizes path separators', () => {
    assert.equal(sourceWithPrefix('wiki', 'concepts\\agent.md'), 'wiki/concepts/agent.md');
});

test('isWikiSource detects maintained wiki sources', () => {
    assert.equal(isWikiSource('wiki/concepts/agent.md'), true);
    assert.equal(isWikiSource('raw/agent.md'), false);
});
