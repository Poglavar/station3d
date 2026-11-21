// Locks Shift-inspection identity recovery for merged and batched buildings.

import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectionIdentityForHit } from '../core/inspection-identity.js';

test('merged building hit resolves the entity range owning its face', () => {
    const ranges = [
        { start: 0, count: 6, key: 'gdi:building:61752', metadata: { objectId: '61752' } },
        { start: 6, count: 3, key: 'gdi:building:99', metadata: { objectId: '99' } },
    ];
    assert.deepEqual(
        inspectionIdentityForHit({ object: { userData: { entityRanges: ranges } }, faceIndex: 1 }),
        {
            key: 'gdi:building:61752',
            metadata: { objectId: '61752' },
            objectId: '61752',
            batchId: null,
        },
    );
});

test('far building hit resolves object id from its batch instance', () => {
    assert.deepEqual(
        inspectionIdentityForHit({
            object: { userData: { objectIdsByBatchId: [61752, 61764] } },
            batchId: 1,
            faceIndex: 0,
        }),
        { key: null, metadata: null, objectId: 61764, batchId: 1 },
    );
});

test('legacy single building mesh keeps its direct identity', () => {
    assert.deepEqual(
        inspectionIdentityForHit({
            object: {
                userData: {
                    objectId: 8,
                    entityKey: 'gdi:building:8',
                    entityMetadata: { key: 'gdi:building:8', objectId: '8' },
                },
            },
            faceIndex: 0,
        }),
        {
            key: 'gdi:building:8',
            metadata: { key: 'gdi:building:8', objectId: '8' },
            objectId: '8',
            batchId: null,
        },
    );
});
