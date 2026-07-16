import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkDocument, getSupportedSourceExtensions } from '../../rag/chunker.js';
import {
    DEFAULT_SOURCE_EXTENSIONS,
    iterateSourceDocuments,
    iterateSourceDocumentsFromRoots
} from '../../rag/documentLoader.js';
import { SourceDocument } from '../../rag/types.js';

test('document loader uses the chunker-supported default extensions', () => {
    assert.deepEqual(
        Array.from(DEFAULT_SOURCE_EXTENSIONS).sort(),
        getSupportedSourceExtensions().sort()
    );
});

test('iterateSourceDocuments loads default supported text files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-'));
    await fs.writeFile(path.join(dir, 'note.md'), '# Note\nmarkdown body', 'utf-8');
    await fs.writeFile(path.join(dir, 'plain.txt'), 'plain text body', 'utf-8');
    await fs.writeFile(path.join(dir, 'ignored.json'), '{"ignored":true}', 'utf-8');

    const documents = await collectDocuments(iterateSourceDocuments(dir));
    const sources = documents.map(document => document.source).sort();

    assert.deepEqual(sources, ['note.md', 'plain.txt']);
    assert.equal(documents.every(document => chunkDocument(document).length > 0), true);
});

test('iterateSourceDocuments reads each file only when it is consumed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-lazy-'));
    await fs.writeFile(path.join(dir, 'a.md'), 'original a', 'utf-8');
    await fs.writeFile(path.join(dir, 'b.md'), 'original b', 'utf-8');

    const iterator = iterateSourceDocuments(dir);
    const first = await iterator.next();
    if (first.done) assert.fail('expected the first document');

    const remainingSource = first.value.source === 'a.md' ? 'b.md' : 'a.md';
    await fs.writeFile(path.join(dir, remainingSource), 'updated after first yield', 'utf-8');

    const second = await iterator.next();
    if (second.done) assert.fail('expected the second document');
    assert.equal(second.value.source, remainingSource);
    assert.equal(second.value.content, 'updated after first yield');
});

test('iterateSourceDocumentsFromRoots prefixes sources from multiple roots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-roots-'));
    const wikiDir = path.join(dir, 'wiki');
    const rawDir = path.join(dir, 'raw');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(wikiDir, 'index.md'), '# Wiki\ncompiled knowledge', 'utf-8');
    await fs.writeFile(path.join(rawDir, 'source.md'), '# Source\nraw knowledge', 'utf-8');

    const documents = await collectDocuments(iterateSourceDocumentsFromRoots([
        { prefix: 'wiki', root: wikiDir, kind: 'wiki', priority: 100, ignore: [] },
        { prefix: 'raw', root: rawDir, kind: 'raw', priority: 50, ignore: [] }
    ]));
    const sources = documents.map(document => document.source).sort();

    assert.deepEqual(sources, ['raw/source.md', 'wiki/index.md']);
});

test('iterateSourceDocumentsFromRoots applies source ignore patterns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-agent-doc-loader-ignore-'));
    const rawDir = path.join(dir, 'raw');
    await fs.mkdir(path.join(rawDir, '__pycache__'), { recursive: true });
    await fs.writeFile(path.join(rawDir, 'keep.md'), '# Keep\nindexed', 'utf-8');
    await fs.writeFile(path.join(rawDir, '__pycache__', 'ignored.md'), '# Ignore\nnot indexed', 'utf-8');

    const documents = await collectDocuments(iterateSourceDocumentsFromRoots([
        { prefix: 'raw', root: rawDir, kind: 'raw', priority: 50, ignore: ['**/__pycache__/**'] }
    ]));

    assert.deepEqual(documents.map(document => document.source), ['raw/keep.md']);
});

async function collectDocuments(documents: AsyncIterable<SourceDocument>): Promise<SourceDocument[]> {
    const collected: SourceDocument[] = [];
    for await (const document of documents) collected.push(document);
    return collected;
}
