import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeCatalog, parseKnowledgeCatalog } from '../../rag/knowledgeCatalog.js';
import { formatRerankDocument, governanceRankingPrior } from '../../rag/retrievalPipeline.js';

test('KnowledgeCatalog excludes non-active and expired documents from new indexes', () => {
    const catalog = new KnowledgeCatalog(parseKnowledgeCatalog({
        version: 1,
        records: [
            {
                sourceId: 'raw/old.md',
                versionId: 'doc@1',
                status: 'superseded',
                authority: 'low',
                quality: 0.3,
                consistencyStatus: 'clear',
                supersededBy: 'doc@2'
            },
            {
                sourceId: 'wiki/current.md',
                versionId: 'doc@2',
                status: 'active',
                authority: 'high',
                quality: 0.9,
                consistencyStatus: 'conditional',
                validFrom: '2026-01-01',
                validTo: '2026-12-31'
            }
        ]
    }));

    assert.equal(catalog.shouldIndex('raw/old.md', new Date('2026-08-20')), false);
    assert.equal(catalog.shouldIndex('wiki/current.md', new Date('2026-08-20')), true);
    assert.equal(catalog.shouldIndex('wiki/current.md', new Date('2027-01-01')), false);
    assert.equal(catalog.shouldIndex('unlisted.md'), true);
});

test('KnowledgeCatalog decorates chunks for reranking and applies a bounded soft prior', () => {
    const catalog = new KnowledgeCatalog(parseKnowledgeCatalog({
        version: 1,
        records: [{
            sourceId: 'wiki/current.md',
            versionId: 'doc@2',
            status: 'active',
            authority: 'high',
            quality: 0.9,
            consistencyStatus: 'conditional',
            claims: [
                { claimId: 'base', entity: '示例公司', metric: '估值', value: 80, asOf: '2026-08-20', scenario: 'base', method: 'PE', chapter: '估值' },
                { claimId: 'template', entity: '示例公司', metric: '估值', value: 75, asOf: '2026-08-20', scenario: 'summary', method: 'template', assumption: '极简结论' }
            ]
        }]
    }));
    const chunk = catalog.decorateChunk({
        id: 'wiki/current.md#1',
        source: 'wiki/current.md',
        text: 'current rule',
        start: 0,
        end: 12
    });

    const rerankText = formatRerankDocument(chunk, 'metadata-prefixed');
    assert.match(rerankText, /version: doc@2/);
    assert.match(rerankText, /authority: high/);
    assert.ok(governanceRankingPrior(chunk) > 0);
    assert.ok(governanceRankingPrior(chunk) < 0.1);
    assert.deepEqual(
        catalog.findClaims({ entity: '示例公司', metric: '估值' }).map(item => item.claim.value),
        [80, 75]
    );
});

test('KnowledgeCatalog validates lifecycle references and duplicate sources', () => {
    assert.throws(() => parseKnowledgeCatalog({
        version: 1,
        records: [{
            sourceId: 'old.md',
            versionId: 'doc@1',
            status: 'superseded',
            authority: 'normal',
            quality: 0.5,
            consistencyStatus: 'clear'
        }]
    }), /requires supersededBy/);
    assert.throws(() => parseKnowledgeCatalog({
        version: 1,
        records: [
            { sourceId: 'a.md', versionId: 'a@1', status: 'active', authority: 'normal', quality: 0.5, consistencyStatus: 'clear' },
            { sourceId: 'A.md', versionId: 'a@2', status: 'active', authority: 'normal', quality: 0.5, consistencyStatus: 'clear' }
        ]
    }), /duplicate knowledge sourceId/);
});
