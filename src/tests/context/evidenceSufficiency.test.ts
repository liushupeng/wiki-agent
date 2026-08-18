import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceLedger, assessEvidence } from '../../context/evidenceSufficiency.js';

test('evidence sufficiency has deterministic three-state boundaries', () => {
    assert.equal(assessEvidence([]).state, 'insufficient');
    assert.equal(assessEvidence([entry({ citation: undefined })]).state, 'partial');
    assert.equal(assessEvidence([entry({})]).state, 'sufficient');
    assert.equal(assessEvidence([entry({ truncated: true })], { allowTruncated: false }).state, 'partial');
});

test('EvidenceLedger deduplicates evidence and extracts compatible RAG tool results', () => {
    const ledger = new EvidenceLedger(() => new Date('2026-01-01T00:00:00.000Z'));
    const result = {
        status: 'success' as const,
        data: {
            query: 'agent',
            matches: [
                { source: 'wiki/agent.md', chunkId: 'chunk-1', citation: 'wiki/agent.md > Design' },
                { source: 'wiki/agent.md', chunkId: 'chunk-1', citation: 'wiki/agent.md > Design' }
            ]
        },
        metadata: { truncated: false }
    };

    assert.equal(ledger.recordToolResult('search_notes', result).length, 2);
    assert.equal(ledger.list().length, 1);
    assert.equal(ledger.assess().state, 'sufficient');
    assert.equal(ledger.recordToolResult('read_file', result).length, 0);
});

function entry(overrides: Partial<ReturnType<EvidenceLedger['list']>[number]>) {
    return {
        id: 'id',
        toolName: 'search_notes',
        source: 'wiki/agent.md',
        chunkId: 'chunk-1',
        citation: 'wiki/agent.md > Design',
        truncated: false,
        observedAt: '2026-01-01T00:00:00.000Z',
        ...overrides
    };
}
