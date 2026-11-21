import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceOpeningTopologySteps } from '../core/surface-opening-topology.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION, compileSurfaceClaim } from '../core/surface-hierarchy.js';

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const surfaceLimits = { maxRegions: 16, maxSourceVertices: 128, maxCandidates: 16, maxFragments: 128 };
const terrainLimits = { maxSources: 16, maxSourceVertices: 128, maxIndexEntries: 2048,
    maxCellCandidates: 16, maxOperandVertices: 128, maxIntersections: 128, maxOutputTriangles: 128 };
const regionAt = (x = 0, z = 0) => ({
    ring: [{ x, z }, { x: x + 8, z }, { x: x + 8, z: z + 8 }, { x, z: z + 8 }],
    minPlane: { x, y: -4, z, slopeX: .5, slopeZ: .25 }, maxY: 1, maxYExclusive: true,
});
const area = triangles => triangles.reduce((sum, [a, b, c]) =>
    sum + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) * .5, 0);
const faceAt = (x, z, y) => [{ x, z, y }, { x: x + 8, z, y }, { x, z: z + 8, y }];

test('sloping excavation bottoms preserve lower ground in both compilers and translated terrain storage', () => {
    for (const [x, z] of [[0, 0], [8192, -4096]]) {
        const source = regionAt(x, z), before = structuredClone(source);
        const surface = drain(createSurfaceOpeningTopologySteps({ regions: [source], limits: surfaceLimits }));
        let terrain = drain(createTerrainCutoutTopologySteps({ layers: [{ operation: 'subtract', regions: [source] }], limits: terrainLimits }));
        const storageOrigin = { x, z };
        terrain = drain(terrain.prepareReceiverStorageSteps({ bounds: { minX: x, minZ: z, maxX: x + 8, maxZ: z + 8 }, storageOrigin }));
        for (const topology of [surface, terrain]) {
            const options = topology === terrain ? { storageOrigin } : {};
            for (const y of [-5, 1, 3]) assert.equal(drain(topology.clipTriangleSteps(...faceAt(x, z, y), options)).unchanged, true);
            // At y=-2, the removed area is .5*4*8 = 16 m² (x/2+z/4<=2).
            // The original triangle is 32 m². This is an independent analytic
            // answer, not one compiler serving as the oracle for the other.
            const cut = drain(topology.clipTriangleSteps(...faceAt(x, z, -2), options));
            assert.equal(cut.unchanged, false);
            assert.ok(Math.abs(area(cut.triangles) - 16) < 1e-9);
            for (const p of cut.triangles.flat()) assert.ok(.5 * (p.x - x) + .25 * (p.z - z) >= 2 - 1e-9);
        }
        assert.equal(surface.contains(x + 1, -2, z + 1), true);
        assert.equal(surface.contains(x + 5, -2, z + 1), false);
        source.minPlane.y = -100;
        assert.equal(surface.contains(x + 5, -2, z + 1), false, 'the captured plane cannot alias a source edit');
        assert.deepEqual(surface.regions[0].minPlane, before.minPlane);
    }
});

test('opening reads retain the backstop plane and a vertical-only floor edit invalidates its terrain tile', () => {
    const region = regionAt(), claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL });
    const read = drain(createSurfaceOpeningReadSteps({ planner: [{ ...region, kind: 'ramp' }], limits: surfaceLimits }));
    const layers = drain(read.terrainLayersSteps(claim));
    assert.deepEqual(layers[0].regions[0].minPlane, region.minPlane);
    assert.equal(read.contains(5, -2, 1, claim), false);
    const rows = [{ key: '0_0', tileX: 0, tileZ: 0 }, { key: '2_0', tileX: 2, tileZ: 0 }];
    const options = { tileM: 40, maxRegions: 16, maxVertices: 128 };
    const first = drain(prepareTerrainCutoutTilesSteps(layers, rows, options));
    for (const key of ['x', 'y', 'z', 'slopeX', 'slopeZ']) {
        const changed = structuredClone(layers);
        changed[0].regions[0].minPlane[key] += .000001;
        const next = drain(prepareTerrainCutoutTilesSteps(changed, rows, options));
        assert.notEqual(next.get('0_0').signature, first.get('0_0').signature, key);
        assert.equal(next.get('2_0').signature, first.get('2_0').signature, key);
    }
});

test('malformed excavation planes reject the candidate instead of becoming unlimited downward cuts', () => {
    for (const minPlane of [{}, { x: 0, y: -4, z: 0, slopeX: NaN, slopeZ: 0 },
        { x: 0, y: -4, z: 0, slopeX: 0, slopeZ: Infinity }]) {
        const region = { ...regionAt(), minPlane };
        for (const steps of [createSurfaceOpeningTopologySteps({ regions: [region], limits: surfaceLimits }),
            createTerrainCutoutTopologySteps({ layers: [{ operation: 'subtract', regions: [region] }], limits: terrainLimits })]) {
            assert.throws(() => drain(steps), /plane/i);
        }
    }
});
