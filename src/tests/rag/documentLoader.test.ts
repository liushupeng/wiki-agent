import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkDocument, getSupportedSourceExtensions } from '../../rag/chunker.js';
import { DEFAULT_SOURCE_EXTENSIONS, loadSourceDocuments } from '../../rag/documentLoader.js';

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
