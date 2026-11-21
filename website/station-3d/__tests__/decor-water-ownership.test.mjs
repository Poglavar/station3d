import test from 'node:test';
import assert from 'node:assert/strict';
import { mappedSeaCoversDecorWaterPolygon } from '../core/decor-water-ownership.js';

const ring = Array.from({ length: 20 }, (_, index) => ({ x: index, z: 0 }));

test('sea ownership is decided per decor-water polygon', () => {
    assert.equal(mappedSeaCoversDecorWaterPolygon(ring, () => true), true);
    assert.equal(mappedSeaCoversDecorWaterPolygon(ring, x => x < 2), false,
        'a river mouth touching the sea remains inland-water owned upstream');
    assert.equal(mappedSeaCoversDecorWaterPolygon(ring, x => x < 18), true,
        'minor boundary disagreement does not duplicate an otherwise marine polygon');
});

test('invalid or underspecified rings never claim sea ownership', () => {
    assert.equal(mappedSeaCoversDecorWaterPolygon([], () => true), false);
    assert.equal(mappedSeaCoversDecorWaterPolygon([{ x: 0, z: 0 }], () => true), false);
    assert.equal(mappedSeaCoversDecorWaterPolygon(ring, null), false);
});
