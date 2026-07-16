import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getKnowledgeSourceRoots, isWikiSource, loadKnowledgeSourceRoots, parseKnowledgeSourceConfigs, sourceWithPrefix } from '../../rag/sourceRoots.js';

test('parseKnowledgeSourceConfigs parses knowledge source config objects', () => {
    assert.deepEqual(parseKnowledgeSourceConfigs({ sources: [
        { name: 'wiki', root: 'wiki', kind: 'wiki', enabled: true, index: true, priority: 100 },
        { name: 'raw', root: 'notes', kind: 'raw', ignore: ['**/__pycache__/**'] }
    ] }), [
        { name: 'wiki', root: 'wiki', kind: 'wiki', enabled: true, index: true, priority: 100, ignore: [] },
        { name: 'raw', root: 'notes', kind: 'raw', ignore: ['**/__pycache__/**'] }
    ]);
});

test('parseKnowledgeSourceConfigs rejects invalid shapes and duplicate names', () => {
    assert.throws(() => parseKnowledgeSourceConfigs({}), /must contain a "sources" array/);
    assert.throws(() => parseKnowledgeSourceConfigs([]), /must contain a "sources" array/);
    assert.throws(() => parseKnowledgeSourceConfigs({ sources: [
        { name: 'raw', root: 'notes', kind: 'unknown' }
    ] }), /kind must be one of/);
    assert.throws(() => parseKnowledgeSourceConfigs({ sources: [
        { name: 'raw', root: 'notes', kind: 'raw' },
        { name: 'raw', root: 'other', kind: 'raw' }
    ] }), /duplicate knowledge source name/);
});

test('loadKnowledgeSourceRoots returns enabled indexable roots sorted by priority', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-source-roots-'));
    const configPath = path.join(dir, 'knowledge.sources.jsonc');
    await fs.writeFile(configPath, `{
        // Comments and trailing commas are valid in JSONC.
        "sources": [
            { "name": "raw", "root": "notes", "kind": "raw", "priority": 50, "ignore": ["**/__pycache__/**",], },
            { "name": "wiki", "root": "wiki", "kind": "wiki", "priority": 100 },
            { "name": "disabled", "root": "disabled", "kind": "raw", "enabled": false },
            { "name": "notIndexed", "root": "not-indexed", "kind": "raw", "index": false },
        ],
    }`, 'utf-8');

    assert.deepEqual(await loadKnowledgeSourceRoots(configPath), [
        { prefix: 'wiki', root: 'wiki', kind: 'wiki', priority: 100, ignore: [] },
        { prefix: 'raw', root: 'notes', kind: 'raw', priority: 50, ignore: ['**/__pycache__/**'] }
    ]);
});

test('getKnowledgeSourceRoots reads path from KNOWLEDGE_SOURCES_CONFIG_PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-source-roots-env-'));
    const configPath = path.join(dir, 'knowledge.sources.jsonc');
    await fs.writeFile(configPath, JSON.stringify({
        sources: [{ name: 'raw', root: 'notes', kind: 'raw' }]
    }), 'utf-8');

    assert.deepEqual(await getKnowledgeSourceRoots({ KNOWLEDGE_SOURCES_CONFIG_PATH: configPath }), [
        { prefix: 'raw', root: 'notes', kind: 'raw', priority: 50, ignore: [] }
    ]);
});

test('sourceWithPrefix normalizes path separators', () => {
    assert.equal(sourceWithPrefix('wiki', 'concepts\\agent.md'), 'wiki/concepts/agent.md');
});

test('isWikiSource detects maintained wiki sources', () => {
    assert.equal(isWikiSource('wiki/concepts/agent.md'), true);
    assert.equal(isWikiSource('raw/agent.md'), false);
});
