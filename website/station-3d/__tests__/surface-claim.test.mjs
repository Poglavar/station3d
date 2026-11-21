import test from 'node:test';
import assert from 'node:assert/strict';

import { markSurfaceClaim, surfaceClaimForObject } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
} from '../core/surface-hierarchy.js';

test('surface claims attach without a THREE dependency and inherit through parents', () => {
    const parent = { userData: {}, parent: null };
    const child = { userData: {}, parent };
    const claim = markSurfaceClaim(parent, {
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        supportReady: true,
        verticalBand: 'ground',
    });

    assert.equal(surfaceClaimForObject(child), claim);
    assert.equal(claim.capabilities.support, true);
    assert.ok(Object.isFrozen(claim));
    assert.ok(Object.isFrozen(claim.capabilities));
});

test('a child claim overrides its parent claim', () => {
    const parent = { userData: {}, parent: null };
    const child = { userData: {}, parent };
    markSurfaceClaim(parent, {
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    const childClaim = markSurfaceClaim(child, {
        surfaceClass: SURFACE_CLASS.ROAD_MARKING,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    assert.equal(surfaceClaimForObject(child), childClaim);
});
