import assert from 'node:assert/strict';
import test from 'node:test';

import {
    decorSurfaceEdgingTypeIndex,
    decorSurfaceNeedsPhysicalEdging,
} from '../core/decor-surface-edging.js';

test('generic natural landuse never invents a physical curb', () => {
    for (const surfaceType of ['green', 'forest', 'water', null]) {
        assert.equal(decorSurfaceNeedsPhysicalEdging(surfaceType), false, String(surfaceType));
        assert.equal(decorSurfaceEdgingTypeIndex(surfaceType), -1, String(surfaceType));
    }
});

test('finished surfaces can retain their explicit perimeter dressing', () => {
    for (const surfaceType of ['flowerbed', 'paving', 'sand', 'playground', 'fitness']) {
        assert.equal(decorSurfaceNeedsPhysicalEdging(surfaceType), true, surfaceType);
        assert.ok(decorSurfaceEdgingTypeIndex(surfaceType) >= 0, surfaceType);
    }
});
