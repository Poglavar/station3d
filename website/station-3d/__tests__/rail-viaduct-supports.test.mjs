// Locks paired support placement at a road crossing and ordinary nominal piers.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveViaductPierFootingY,
    resolveViaductSupportCandidates,
} from '../core/rail-viaduct-supports.js';

const sampleAt = station => ({ station, x: station, z: 0, railY: 7 });

test('a blocked roadbed support resolves to the clear sidewalk on both sides', () => {
    const supports = resolveViaductSupportCandidates({
        nominalStation: 50,
        startStation: 30,
        endStation: 70,
        sampleAt,
        clearanceAt: candidate => Math.abs(candidate.station - 50) - 7,
    });
    assert.deepEqual(supports.map(item => item.station), [43, 57]);
});

test('an unobstructed nominal support remains a single support', () => {
    const supports = resolveViaductSupportCandidates({
        nominalStation: 50,
        startStation: 30,
        endStation: 70,
        sampleAt,
        clearanceAt: () => 2,
    });
    assert.deepEqual(supports.map(item => item.station), [50]);
});

test('a mapped-sea pier continues below the water surface when terrain is NoData', () => {
    assert.equal(resolveViaductPierFootingY({
        terrainY: null,
        mappedSea: true,
        seaSurfaceY: -22.4,
        waterEmbedDepthM: 3,
    }), -25.4);
});

test('real terrain outranks the mapped-sea fallback at a bridge abutment', () => {
    assert.equal(resolveViaductPierFootingY({
        terrainY: -18.5,
        mappedSea: true,
        seaSurfaceY: -22.4,
    }), -18.5);
});

test('unknown non-water terrain never becomes a fabricated pier footing', () => {
    assert.equal(resolveViaductPierFootingY({
        terrainY: null,
        mappedSea: false,
        seaSurfaceY: -22.4,
    }), null);
});
