import test from 'node:test';
import assert from 'node:assert/strict';
import { createMappedCoastline, clipMappedCoastQuadToWindow } from '../core/coastline-mask.js';
import { compileMappedWaterSurfaceSteps, captureMappedWaterOpeningsSteps, sameMappedWaterGeometrySteps } from '../core/mapped-water-ground.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';

const drain = steps => { for (let i = 0; i < 100000; i++) { const n = steps.next(); if (n.done) return n.value; } assert.fail('unbounded'); };
const ring = (x, z, half) => [[x-half,z-half],[x+half,z-half],[x+half,z+half],[x-half,z+half],[x-half,z-half]];
const limits = { maxSourceVertices: 1024, maxOperandVertices: 1024, maxIntersections: 2048, maxOutputTriangles: 2048 };
const claim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };
function compile(polys, options = {}) {
    return drain(compileMappedWaterSurfaceSteps({ coastline: createMappedCoastline(polys),
        centerX: 0, centerZ: 0, halfSizeM: 10, seaY: -1, limits, ...options }));
}
function openings(surfaces) {
    const water = drain(captureMappedWaterOpeningsSteps({ surfaces, replacementKey: 'mapped-sea', limits: GROUND_GENERATION_LIMITS.openings }));
    return drain(createSurfaceOpeningReadSteps({ water, limits: GROUND_GENERATION_LIMITS.openings }));
}
test('remote water sources are clipped to the simulation window, preserving islands and stored sea faces', () => {
    const surface = compile([{ outer: ring(400, 800, 50000), holes: [ring(400, 800, 2)] }], { centerX: 400, centerZ: 800 });
    let area = 0;
    const p = surface.positions;
    for (let i = 0; i < p.length; i += 9) {
        area += Math.abs((p[i+3]-p[i])*(p[i+8]-p[i+2])-(p[i+6]-p[i])*(p[i+5]-p[i+2])) / 2;
        for (let j = 0; j < 9; j += 3) {
            assert.ok(p[i+j] >= -10 && p[i+j] <= 10); assert.ok(p[i+j+2] >= -10 && p[i+j+2] <= 10);
            assert.equal(p[i+j+1], -1);
        }
    }
    assert.equal(surface.originX, 400); assert.equal(surface.originZ, 800);
    assert.equal(area, 400 - 16);
    const read = openings([surface]);
    assert.equal(read.contains(405, 0, 800, claim), true);
    assert.equal(read.contains(400, 0, 800, claim), false, 'island remains ground');
    assert.equal(read.contains(415, 0, 800, claim), false, 'outside the finite sea remains ground');
    assert.equal(read.contains(405, -1.1, 800, claim), false, 'submerged terrain remains below the actual sea');
    assert.equal(read.contains(405, 0, 800, { ...claim, replacementKey: 'mapped-sea' }), false);
});

test('geometry reuse includes both sea and coast origins even when all stored arrays are identical', () => {
    const sea = compile([{ outer: ring(0,0,5) }]);
    const geometry = Object.fromEntries(['collarPositions','collarNormals','collarUvs','wallPositions','wallNormals'].map(key => [key, new Float32Array()]));
    Object.assign(geometry, { originX: 0, originZ: 0 });
    const prior = { sea, geometry };
    assert.equal(drain(sameMappedWaterGeometrySteps(prior, { sea: { ...sea }, geometry: { ...geometry } }, () => true)), true);
    for (const kind of ['sea','geometry']) for (const axis of ['originX','originZ']) {
        const next = { ...prior, [kind]: { ...prior[kind], [axis]: 100000.321 } };
        assert.equal(drain(sameMappedWaterGeometrySteps(prior, next, () => true)), false);
    }
});
test('overlapping sea polygons do not create duplicate water faces, including clipped island edges', () => {
    const surface = compile([{ outer: ring(0, 0, 20), holes: [ring(10, 0, 2)] }, { outer: ring(-4, 0, 3) }]);
    const read = openings([surface]);
    assert.equal(read.contains(9, 0, 0, claim), false);
    assert.equal(read.contains(-4, 0, 0, claim), true);
    let area = 0;
    const p = surface.positions;
    for (let i=0;i<p.length;i+=9) area += Math.abs((p[i+3]-p[i])*(p[i+8]-p[i+2])-(p[i+6]-p[i])*(p[i+5]-p[i+2]))/2;
    assert.equal(area, 392);
});
test('coast removal begins at its actual sloped infill, excluding vertical walls', () => {
    const positions = new Float32Array([0,0,0, 0,2,2, 2,2,0, 0,0,0, 0,-2,0, 0,0,2]);
    const read = openings([{ positions }]);
    assert.equal(read.regions.length, 1);
    assert.equal(read.contains(.5, 1.1, .5, claim), true);
    assert.equal(read.contains(.5, .9, .5, claim), false);
});
test('empty, stale and oversized water inputs cannot leave a partial opening', () => {
    assert.equal(compile([]).triangleCount, 0);
    assert.equal(openings([]).empty, true);
    assert.throws(() => compile([{ outer: ring(0,0,5) }], { limits: { ...limits, maxSourceVertices: 3 } }), /capacity/);
    let current = true, time = 0;
    const steps = compileMappedWaterSurfaceSteps({ coastline: createMappedCoastline([{ outer: ring(0,0,5) }]),
        centerX: 0, centerZ: 0, halfSizeM: 10, seaY: -1, limits, now: () => time++, isCurrent: () => current });
    assert.equal(steps.next().done, false); current = false;
    assert.throws(() => steps.next(), /expired|superseded/);
});

test('a long shoreline crossing the window survives even with its midpoint outside it', () => {
    const quad = { shoreA: [0,-5000], shoreB: [0,500], landA: [-5,-5000], landB: [-5,500] };
    const clipped = clipMappedCoastQuadToWindow(quad, 0, 0, 100);
    assert.deepEqual(clipped, { shoreA: [0,-100], shoreB: [0,100], landA: [-5,-100], landB: [-5,100] });
    assert.equal(clipMappedCoastQuadToWindow(quad, 500, 0, 100), null);
    assert.equal(clipMappedCoastQuadToWindow(clipped, 0, 0, 100), clipped);
});

test('locally representable submillimetre shoreline detail retains valid stored faces', () => {
    const surface = compile([{ outer: [[498,500],[500,500.00001],[502,500],[502,502],[498,502],[498,500]] }],
        { centerX: 500, centerZ: 500 });
    assert.equal(surface.triangleCount, 3);
    // The fifth boundary vertex used to disappear when rounded near (500,500).
    // Local storage preserves its small indentation and positive face areas.
    let area = 0;
    const p = surface.positions;
    for (let i=0; i<p.length; i+=9) {
        const up = (p[i+5]-p[i+2])*(p[i+6]-p[i])-(p[i+3]-p[i])*(p[i+8]-p[i+2]);
        assert.ok(up > 0); area += up/2;
    }
    assert.ok(Math.abs(area-(8-2e-5)) < 1e-7);
    const read = openings([surface]);
    assert.equal(read.contains(500, 0, 501, claim), true);
    assert.equal(read.contains(500, 0, 499, claim), false);
});
