// Pins the parking broad phase without THREE or a browser. A negative answer
// must be proof that exact per-vertex road-formation lookup cannot win; a
// possible touch deliberately falls back to the existing exact path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    localBoundsOverlap,
    localRingBounds,
    parkingMayOverlapRoadFormation,
} from '../core/parking-formation-overlap.js';
import { placementSceneY } from '../core/terrain-placement.js';

const DECOR_SRC = readFileSync(
    fileURLToPath(new URL('../world/decor.js', import.meta.url)),
    'utf8',
);

const parking = [
    { x: 10, z: 20 },
    { x: 30, z: 20 },
    { x: 30, z: 40 },
    { x: 10, z: 40 },
];

test('ring bounds ignore malformed points and retain local XZ extents', () => {
    assert.deepEqual(localRingBounds([...parking, { x: NaN, z: 0 }]), {
        minX: 10,
        minZ: 20,
        maxX: 30,
        maxZ: 40,
    });
});

test('a distant road formation is rejected for the whole parking polygon', () => {
    assert.equal(parkingMayOverlapRoadFormation(parking, [{
        bounds: { minX: 100, minZ: 100, maxX: 120, maxZ: 120 },
    }]), false);
});

test('touching or overlapping bounds preserve the exact formation path', () => {
    assert.equal(parkingMayOverlapRoadFormation(parking, [{
        bounds: { minX: 30, minZ: 25, maxX: 50, maxZ: 35 },
    }]), true, 'a boundary touch is conservatively retained');
    assert.equal(localBoundsOverlap(
        { minX: 12, minZ: 22, maxX: 15, maxZ: 25 },
        { minX: 10, minZ: 20, maxX: 30, maxZ: 40 },
    ), true);
});

test('missing or invalid profile bounds cannot force an exact lookup', () => {
    assert.equal(parkingMayOverlapRoadFormation(parking, [null, {}, { bounds: null }]), false);
    assert.equal(parkingMayOverlapRoadFormation([], [{
        bounds: { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
    }]), false);
});

test('the broad-phase decision controls both parking asphalt and bay paint', () => {
    assert.match(DECOR_SRC,
        /let parkingUsesFormation = false[\s\S]*?surfaceType === 'parking'[\s\S]*?parkingMayOverlapRoadFormation/,
        'each parking polygon computes one conservative broad-phase decision');
    const initialBroadPhaseStart = DECOR_SRC.indexOf('let parkingUsesFormation = false');
    const initialBroadPhase = DECOR_SRC.slice(
        initialBroadPhaseStart,
        DECOR_SRC.indexOf('const verts = []', initialBroadPhaseStart),
    );
    assert.ok(
        initialBroadPhase.indexOf('waitForPublishedRoadFormation')
            < initialBroadPhase.indexOf('parkingMayOverlapRoadFormation'),
        'the current-generation profile query waits for the roads layer before its first use',
    );
    assert.match(DECOR_SRC,
        /currentRevision !== sampledFormationRevision[\s\S]*?parkingUsesFormation = parkingMayOverlapRoadFormation/,
        'a resumed parking build recomputes its broad phase against the published road revision');
    assert.match(DECOR_SRC,
        /decorSurfaceYAt\(surfaceType, ax, az, parkingUsesFormation\)/,
        'surface vertices use terrain-only placement after a negative decision');
    assert.match(DECOR_SRC,
        /parkingUsesFormation\s*\? parkingFormationMarkingVertices\s*:\s*parkingMarkingVertices/,
        'bay paint preserves the exact path only for possible overlaps');
});

test('a rejected lot performs zero exact formation queries across all vertices', () => {
    let formationQueries = 0;
    const terrain = {
        roadFormation: {
            surfaceAtLocal() {
                formationQueries += 1;
                return null;
            },
        },
        sceneYAtLocal(x, z) {
            return x + z;
        },
    };
    const preferRoadSurface = parkingMayOverlapRoadFormation(parking, [{
        bounds: { minX: 100, minZ: 100, maxX: 120, maxZ: 120 },
    }]);
    const heights = parking.map(({ x, z }) => (
        placementSceneY(terrain, x, z, 0.02, { preferRoadSurface })
    ));

    assert.equal(formationQueries, 0);
    assert.deepEqual(heights, [30.02, 50.02, 70.02, 50.02]);
});

test('a possible overlap preserves the exact formation query and road height', () => {
    let formationQueries = 0;
    const terrain = {
        roadFormation: {
            surfaceAtLocal() {
                formationQueries += 1;
                return { osmId: 7 };
            },
            sceneYAtLocal() {
                return 12;
            },
        },
        sceneYAtLocal() {
            return 3;
        },
    };
    const preferRoadSurface = parkingMayOverlapRoadFormation(parking, [{
        bounds: { minX: 15, minZ: 25, maxX: 20, maxZ: 30 },
    }]);

    assert.equal(placementSceneY(terrain, 16, 26, 0.02, { preferRoadSurface }), 12.02);
    assert.equal(formationQueries, 1);
});
