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

test('EvidenceLedger downgrades conflicted or low-authority governed evidence', () => {
    const ledger = new EvidenceLedger();
    ledger.recordToolResult('search_notes', {
        status: 'success',
        data: {
            matches: [{
                source: 'wiki/valuation.md',
                chunkId: 'valuation#1',
                citation: 'wiki/valuation.md > 估值',
                governance: { version: 'valuation@2', authority: 'low', consistency: 'conflicted' }
            }]
        }
    });

    const assessment = ledger.assess();
    assert.equal(assessment.state, 'partial');
    assert.equal(assessment.conflictedCount, 1);
    assert.equal(assessment.lowAuthorityCount, 1);
    assert.match(assessment.reasons.join(' '), /场景或方法拆分/);
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
