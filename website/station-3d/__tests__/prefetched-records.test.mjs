// Verifies that large deeplink records are reused while uncached IDs still
// follow the ordinary fetch path and preserve requested ordering.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadRecordsById,
    shouldLoadLegacyGdiCarves,
} from '../core/prefetched-records.js';

test('reuses prefetched records and fetches only missing IDs', async () => {
    const cached = { title: 'Proposal five' };
    const fetched = [];
    const records = await loadRecordsById(
        ['5', '7'],
        [{ id: 5, record: cached }],
        async (id) => {
            fetched.push(String(id));
            return { title: `Proposal ${id}` };
        },
    );
    assert.equal(records[0], cached);
    assert.deepEqual(records[1], { title: 'Proposal 7' });
    assert.deepEqual(fetched, ['7']);
});

test('runs legacy GDI building carves only for Zagreb', () => {
    assert.equal(shouldLoadLegacyGdiCarves('zagreb'), true);
    assert.equal(shouldLoadLegacyGdiCarves('ZAGREB'), true);
    assert.equal(shouldLoadLegacyGdiCarves('split'), false);
    assert.equal(shouldLoadLegacyGdiCarves(null), false);
});
