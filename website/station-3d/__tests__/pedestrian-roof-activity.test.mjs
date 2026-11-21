// Flat-roof pedestrians are owned by one bounded polygon for their entire
// lifetime. Prove edge/hole clearance, chord safety, sampling and streamed
// registry/roof-bench cleanup without relying on a renderer.

import assert from 'node:assert/strict';
import test from 'node:test';

import { getAmbientBenchSeat } from '../core/ambient-bench-seats.js';
import {
    createRoofActivitySurface,
    ROOF_ACTIVITY_MAX_COMPLEXITY,
    roofActivityFigureCapacity,
    roofActivityPointIsSafe,
    roofActivitySegmentIsSafe,
    sampleRoofActivityPoint,
    roofActivityTargetSearchSteps,
} from '../core/pedestrian-roof-activity.js';
import {
    clearRoofActivitySurfaces,
    getRoofActivitySurface,
    registerRoofActivitySurface,
    roofActivitySurfaceCount,
    roofActivitySurfacesNear,
    unregisterRoofActivityOwner,
} from '../world/roof-activity-registry.js';

const OUTER = [
    { x: -10, z: -10 },
    { x: 10, z: -10 },
    { x: 10, z: 10 },
    { x: -10, z: 10 },
];
const HOLE = [
    { x: -2, z: -2 },
    { x: -2, z: 2 },
    { x: 2, z: 2 },
    { x: 2, z: -2 },
];

test.afterEach(clearRoofActivitySurfaces);

test('roof points and movement chords stay clear of edges and holes', () => {
    const surface = createRoofActivitySurface({
        id: 'roof:test',
        ownerId: 'building:test',
        rings: [OUTER, HOLE],
        floorY: 18,
    });
    assert.ok(surface);
    assert.equal(roofActivityPointIsSafe(surface, 8, 8), true);
    assert.equal(roofActivityPointIsSafe(surface, 9.2, 0), false, 'edge margin');
    assert.equal(roofActivityPointIsSafe(surface, 0, 0), false, 'courtyard hole');
    assert.equal(roofActivityPointIsSafe(surface, 2.8, 0), false, 'hole margin');
    assert.equal(
        roofActivitySegmentIsSafe(surface, { x: -8, z: 0 }, { x: 8, z: 0 }),
        false,
        'a direct chord may not cross the courtyard',
    );
    assert.equal(
        roofActivitySegmentIsSafe(surface, { x: -8, z: 8 }, { x: 8, z: 8 }),
        true,
    );
});

test('bounded sampling and area capacity return only usable roof positions', () => {
    const surface = createRoofActivitySurface({
        id: 'roof:sample',
        rings: [OUTER, HOLE],
        floorY: 12,
    });
    const values = [0.5, 0.5, 0.1, 0.1];
    let index = 0;
    const point = sampleRoofActivityPoint(surface, () => values[index++ % values.length], 4);
    assert.ok(point);
    assert.equal(roofActivityPointIsSafe(surface, point.x, point.z), true);
    assert.equal(roofActivityFigureCapacity(surface), 2);
});

test('roof target safety work can be resumed at edge-probe granularity', () => {
    const ring = Array.from({ length: 160 }, (_, index) => {
        const angle = (index / 160) * Math.PI * 2;
        return { x: Math.cos(angle) * 20, z: Math.sin(angle) * 20 };
    });
    const surface = createRoofActivitySurface({
        id: 'roof:resumable',
        rings: [ring],
        floorY: 12,
    });
    assert.ok(surface);
    const search = roofActivityTargetSearchSteps(surface, { x: 0, z: 0 }, {
        random: (() => {
            const values = [0.75, 0.5];
            let index = 0;
            return () => values[index++ % values.length];
        })(),
        targetAttempts: 1,
        sampleAttempts: 1,
    });
    for (let probe = 0; probe < 32; probe++) {
        assert.equal(search.next().done, false, 'a dense ring yields after each bounded probe');
    }
    let result = search.next();
    let totalProbes = 33;
    while (!result.done) {
        result = search.next();
        totalProbes += 1;
    }
    assert.ok(totalProbes > ring.length, 'point and chord checks were split across visits');
    assert.ok(result.value);
    assert.equal(roofActivityPointIsSafe(surface, result.value.x, result.value.z), true);
    assert.equal(
        roofActivitySegmentIsSafe(surface, { x: 0, z: 0 }, result.value),
        true,
    );
});

test('pathological roof complexity is excluded from optional ambient activity', () => {
    const ring = Array.from({ length: ROOF_ACTIVITY_MAX_COMPLEXITY + 1 }, (_, index) => {
        const angle = (index / (ROOF_ACTIVITY_MAX_COMPLEXITY + 1)) * Math.PI * 2;
        return { x: Math.cos(angle) * 20, z: Math.sin(angle) * 20 };
    });
    assert.equal(createRoofActivitySurface({
        id: 'roof:pathological',
        rings: [ring],
        floorY: 12,
    }), null);
});

test('pool footprints remove spawn, route and capacity space from a roof', () => {
    const largeOuter = [
        { x: -12, z: -10 },
        { x: 12, z: -10 },
        { x: 12, z: 10 },
        { x: -12, z: 10 },
    ];
    const obstacle = {
        x: 0,
        z: 0,
        lengthM: 8,
        widthM: 4,
        angle: Math.PI / 6,
        clearanceM: 1,
    };
    const surface = createRoofActivitySurface({
        id: 'roof:pool',
        rings: [largeOuter],
        floorY: 12,
        obstacles: [obstacle],
    });
    assert.ok(surface);
    assert.equal(surface.areaM2, 480);
    assert.equal(surface.obstacleAreaM2, 60);
    assert.equal(surface.usableAreaM2, 420);
    assert.equal(roofActivityPointIsSafe(surface, 0, 0), false, 'inside pool');
    assert.equal(
        roofActivitySegmentIsSafe(surface, { x: -8, z: 0 }, { x: 8, z: 0 }),
        false,
        'a route may not cross pool water',
    );
    assert.equal(
        roofActivitySegmentIsSafe(surface, { x: -8, z: 8 }, { x: 8, z: 8 }),
        true,
    );
    const values = [0.5, 0.5, 0.1, 0.1];
    let index = 0;
    const sampled = sampleRoofActivityPoint(
        surface,
        () => values[index++ % values.length],
        4,
    );
    assert.ok(sampled);
    assert.equal(roofActivityPointIsSafe(surface, sampled.x, sampled.z), true);
    assert.equal(roofActivityFigureCapacity(surface), 2);
});

test('streamed roof ownership publishes and retires ordinary bench seats', () => {
    const surface = registerRoofActivitySurface({
        id: 'roof:registry',
        ownerId: 'building:registry',
        rings: [OUTER],
        floorY: 20,
        benches: [{ x: 5, z: 5, angle: 0 }],
    });
    assert.ok(surface);
    assert.equal(surface.benchCount, 1);
    assert.equal(roofActivitySurfaceCount(), 1);
    assert.equal(getRoofActivitySurface(surface.id), surface);
    assert.deepEqual(roofActivitySurfacesNear(0, 0, 1), [surface]);

    const seat = getAmbientBenchSeat('roof-bench:roof:registry:0');
    assert.ok(seat);
    assert.equal(seat.surfaceId, surface.id);
    assert.equal(seat.seatY, 20.5);

    assert.equal(unregisterRoofActivityOwner('building:registry'), 1);
    assert.equal(getRoofActivitySurface(surface.id), null);
    assert.equal(getAmbientBenchSeat(seat.id), null);
});

test('a roof bench over a pool is not published as a usable seat', () => {
    const surface = registerRoofActivitySurface({
        id: 'roof:pool-benches',
        ownerId: 'building:pool-benches',
        rings: [OUTER],
        floorY: 20,
        obstacles: [{ x: 0, z: 0, lengthM: 8, widthM: 4, angle: 0 }],
        benches: [
            { x: 0, z: 0, angle: 0 },
            { x: 6, z: 6, angle: 0 },
        ],
    });
    assert.ok(surface);
    assert.equal(surface.benchCount, 1);
    assert.equal(getAmbientBenchSeat('roof-bench:roof:pool-benches:0'), null);
    assert.ok(getAmbientBenchSeat('roof-bench:roof:pool-benches:1'));
});

test('an invalid streamed refresh retires the old roof and its bench', () => {
    const id = 'roof:refresh';
    registerRoofActivitySurface({
        id,
        ownerId: 'building:refresh',
        rings: [OUTER],
        floorY: 20,
        benches: [{ x: 5, z: 5, angle: 0 }],
    });
    assert.ok(getRoofActivitySurface(id));
    assert.ok(getAmbientBenchSeat(`roof-bench:${id}:0`));

    const refreshed = registerRoofActivitySurface({
        id,
        ownerId: 'building:refresh',
        rings: [[
            { x: 0, z: 0 },
            { x: 2, z: 0 },
            { x: 2, z: 2 },
            { x: 0, z: 2 },
        ]],
        floorY: 20,
    });
    assert.equal(refreshed, null);
    assert.equal(getRoofActivitySurface(id), null);
    assert.equal(getAmbientBenchSeat(`roof-bench:${id}:0`), null);
});
