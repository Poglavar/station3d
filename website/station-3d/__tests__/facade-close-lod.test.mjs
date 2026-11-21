import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CLOSE_FACADE_MAX_OWNERS,
    closeFacadeTextureScale,
    createCloseFacadeRecordIndex,
    distanceSqToFacadeBounds,
    selectCloseFacadeRecords,
} from '../core/facade-close-lod.js';

test('close facade detail preserves only the inspectable nearest ring', () => {
    assert.equal(CLOSE_FACADE_MAX_OWNERS, 8);
    const records = new Map(Array.from({ length: 12 }, (_unused, index) => [
        `facade-${index}`,
        { bounds: { minX: index + 1, maxX: index + 1.5, minZ: 0, maxZ: 1 } },
    ]));
    assert.deepEqual(
        selectCloseFacadeRecords(records, new Set(), 0, 0).map(({ key }) => key),
        Array.from({ length: 8 }, (_unused, index) => `facade-${index}`),
    );
});

test('close facade distance is measured to the facade bounds, not its centre', () => {
    const bounds = { minX: 10, maxX: 30, minZ: -2, maxZ: 2 };
    assert.equal(distanceSqToFacadeBounds(bounds, 15, 0), 0);
    assert.equal(distanceSqToFacadeBounds(bounds, 4, 0), 36);
    assert.equal(distanceSqToFacadeBounds(bounds, 4, 6), 52);
});

test('explicit zero removes even active close owners instead of restoring the default eight', () => {
    const records = new Map([['near', { bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } }]]);
    assert.deepEqual(selectCloseFacadeRecords(records, new Set(['near']), 0, 0, { maxOwners: 0 }), []);
    const index = createCloseFacadeRecordIndex();
    index.set('near', records.get('near'));
    assert.deepEqual(index.select(new Set(['near']), 0, 0, { maxOwners: 0 }), []);
    assert.equal(index.select(new Set(), 0, 0, { maxOwners: null }).length, 1,
        'a missing budget is not a deliberate zero');
});

test('close facade selection uses hysteresis and caps the nearest owners', () => {
    const records = new Map([
        ['nearest', { bounds: { minX: 5, maxX: 6, minZ: 0, maxZ: 1 } }],
        ['enter', { bounds: { minX: 27, maxX: 28, minZ: 0, maxZ: 1 } }],
        ['hysteresis', { bounds: { minX: 35, maxX: 36, minZ: 0, maxZ: 1 } }],
        ['outside', { bounds: { minX: 41, maxX: 42, minZ: 0, maxZ: 1 } }],
    ]);
    const active = new Set(['hysteresis', 'outside']);
    assert.deepEqual(
        selectCloseFacadeRecords(records, active, 0, 0, { maxOwners: 3 })
            .map(({ key }) => key),
        ['nearest', 'enter', 'hysteresis'],
    );
    assert.deepEqual(
        selectCloseFacadeRecords(records, active, 0, 0, { maxOwners: 2 })
            .map(({ key }) => key),
        ['nearest', 'enter'],
    );
});

test('streamed facade selection queries only the local immutable-record neighborhood', () => {
    const index = createCloseFacadeRecordIndex({ cellM: 20 });
    let farBoundsReads = 0;
    for (let item = 0; item < 1000; item++) {
        const record = {};
        Object.defineProperty(record, 'bounds', {
            enumerable: true,
            get() {
                farBoundsReads += 1;
                const x = 1000 + item * 2;
                return { minX: x, maxX: x + 1, minZ: 1000, maxZ: 1001 };
            },
        });
        index.set(`far-${item}`, record);
    }
    index.set('near', { bounds: { minX: 4, maxX: 5, minZ: 0, maxZ: 1 } });
    index.set('active-exit', { bounds: { minX: 34, maxX: 35, minZ: 0, maxZ: 1 } });
    farBoundsReads = 0;

    assert.deepEqual(
        index.select(new Set(['active-exit']), 0, 0).map(({ key }) => key),
        ['near', 'active-exit'],
    );
    assert.equal(farBoundsReads, 0, 'far records are not revisited by a local query');
    assert.ok(index.stats().candidates < index.stats().records);

    index.delete('near');
    assert.deepEqual(
        index.select(new Set(['active-exit']), 0, 0).map(({ key }) => key),
        ['active-exit'],
    );
    index.clear();
    assert.deepEqual(index.select(new Set(), 0, 0), []);
});

test('close facade texture scaling is bounded to a frame-sized canvas', () => {
    assert.ok(Math.abs(closeFacadeTextureScale(416, 392)
        - Math.sqrt(256_000 / (416 * 392))) < 1e-12);
    assert.equal(closeFacadeTextureScale(3000, 1000), 1);
    assert.equal(closeFacadeTextureScale(100, 100), 2);
    assert.equal(closeFacadeTextureScale(416, 3032), 1);
    assert.equal(closeFacadeTextureScale(0, 392), 1);
});
