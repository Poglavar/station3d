import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRainShelter } from '../core/rain-shelter.js';

test('rain shelter keeps the exterior visible from vehicles and muffles its audio', () => {
    const shelter = resolveRainShelter({ walkMode: null });
    assert.equal(shelter.visualExposure, 1);
    assert.ok(shelter.innerRadiusM >= 3);
    assert.ok(shelter.audioExposure < 0.5);
    assert.ok(shelter.muffled > 0.5);
});

test('rain and its ambience disappear throughout recognized tunnel spans', () => {
    const portal = resolveRainShelter({ insideTunnelSpan: true });
    assert.equal(portal.visualExposure, 0);
    assert.equal(portal.audioExposure, 0);
    const sealed = resolveRainShelter({ insideTunnelSpan: true, outsideSuspended: true });
    assert.equal(sealed.visualExposure, 0);
    assert.equal(sealed.audioExposure, 0);
    assert.equal(resolveRainShelter({ isUndergroundSession: true }).visualExposure, 0);
});

test('walk and static views retain the close rain field', () => {
    assert.equal(resolveRainShelter(null).innerRadiusM, 1.2);
    assert.equal(resolveRainShelter({ walkMode: {} }).audioExposure, 1);
});
