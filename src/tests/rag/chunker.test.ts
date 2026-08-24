import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument, chunkMarkdown, chunkText, getSupportedSourceExtensions, selectChunker } from '../../rag/chunker.js';

test('chunkText splits text with overlap and stable chunk ids', () => {
    const chunks = chunkText('note.txt', 'abcdefghi', 4, 1);

    assert.deepEqual(chunks.map(chunk => chunk.text), ['abcd', 'defg', 'ghi']);
    assert.deepEqual(chunks.map(chunk => chunk.id), ['note.txt#1', 'note.txt#2', 'note.txt#3']);
});

test('chunkText coordinates match trimmed chunk content', () => {
    const source = '  alpha beta  ';
    const [chunk] = chunkText('note.txt', source, 100, 10);

    assert.equal(source.slice(chunk!.start, chunk!.end), chunk!.text);
});

test('chunkMarkdown preserves frontmatter, title path, tags, and wiki links', () => {
    const chunks = chunkMarkdown('note.md', [
        '---',
        'tags: [agent, rag]',
        '---',
        '# Agent Notes',
        'See [[Markdown 笔记索引]] and #local-wiki.'
    ].join('\n'));

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].frontmatter, { tags: ['agent', 'rag'] });
    assert.deepEqual(chunks[0].titlePath, ['Agent Notes']);
    assert.deepEqual(chunks[0].tags, ['agent', 'rag', 'local-wiki']);
    assert.deepEqual(chunks[0].links, ['Markdown 笔记索引']);
    const source = [
        '---',
        'tags: [agent, rag]',
        '---',
        '# Agent Notes',
        'See [[Markdown 笔记索引]] and #local-wiki.'
    ].join('\n');
    assert.equal(source.slice(chunks[0].start, chunks[0].end), chunks[0].text);
});

test('selectChunker dispatches markdown extensions and falls back to text chunking', () => {
    assert.equal(selectChunker({ extension: '.md' }), chunkMarkdown);
    assert.equal(selectChunker({ extension: 'markdown' }), chunkMarkdown);
    assert.equal(selectChunker({ extension: '.unknown' }), chunkText);
});

test('getSupportedSourceExtensions exposes registered chunker extensions', () => {
    assert.deepEqual(getSupportedSourceExtensions().sort(), ['.markdown', '.md', '.txt'].sort());
});

test('chunkDocument uses the selected chunker for a source document', () => {
    const chunks = chunkDocument({
        source: 'plain.txt',
        absolutePath: '/tmp/plain.txt',
        extension: '.txt',
        content: 'plain text'
    });

    assert.equal(chunks[0].source, 'plain.txt');
    assert.equal(chunks[0].text, 'plain text');
});
