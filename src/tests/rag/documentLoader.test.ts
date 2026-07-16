import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkDocument, getSupportedSourceExtensions } from '../../rag/chunker.js';
import { DEFAULT_SOURCE_EXTENSIONS, loadSourceDocuments, loadSourceDocumentsFromRoots } from '../../rag/documentLoader.js';

test('document loader uses the chunker-supported default extensions', () => {
    assert.deepEqual(
        Array.from(DEFAULT_SOURCE_EXTENSIONS).sort(),
        getSupportedSourceExtensions().sort()
    );
});

test('loadSourceDocuments loads default supported text files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-'));
    await fs.writeFile(path.join(dir, 'note.md'), '# Note\nmarkdown body', 'utf-8');
    await fs.writeFile(path.join(dir, 'plain.txt'), 'plain text body', 'utf-8');
    await fs.writeFile(path.join(dir, 'ignored.json'), '{"ignored":true}', 'utf-8');

    const documents = await loadSourceDocuments(dir);
    const sources = documents.map(document => document.source).sort();

    assert.deepEqual(sources, ['note.md', 'plain.txt']);
    assert.equal(documents.every(document => chunkDocument(document).length > 0), true);
});

test('loadSourceDocumentsFromRoots prefixes sources from multiple roots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-roots-'));
    const wikiDir = path.join(dir, 'wiki');
    const rawDir = path.join(dir, 'raw');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(wikiDir, 'index.md'), '# Wiki\ncompiled knowledge', 'utf-8');
    await fs.writeFile(path.join(rawDir, 'source.md'), '# Source\nraw knowledge', 'utf-8');

    const documents = await loadSourceDocumentsFromRoots([
        { prefix: 'wiki', root: wikiDir, kind: 'wiki', priority: 100, ignore: [] },
        { prefix: 'raw', root: rawDir, kind: 'raw', priority: 50, ignore: [] }
    ]);
    const sources = documents.map(document => document.source).sort();

    assert.deepEqual(sources, ['raw/source.md', 'wiki/index.md']);
});

test('loadSourceDocumentsFromRoots applies source ignore patterns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-ignore-'));
    const rawDir = path.join(dir, 'raw');
    await fs.mkdir(path.join(rawDir, '__pycache__'), { recursive: true });
    await fs.writeFile(path.join(rawDir, 'keep.md'), '# Keep\nindexed', 'utf-8');
    await fs.writeFile(path.join(rawDir, '__pycache__', 'ignored.md'), '# Ignore\nnot indexed', 'utf-8');

    const documents = await loadSourceDocumentsFromRoots([
        { prefix: 'raw', root: rawDir, kind: 'raw', priority: 50, ignore: ['**/__pycache__/**'] }
    ]);

    assert.deepEqual(documents.map(document => document.source), ['raw/keep.md']);
});
