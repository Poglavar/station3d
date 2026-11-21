// Verifies that mapped vector water alone owns coastline classification.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMappedCoastLandCollar,
    buildMappedCoastLandCollarSteps,
    buildMappedCoastTerrainCutout,
    createMappedCoastTerrainSurfaceSampler,
    createMappedCoastline,
    resolveMappedCoastTerrainInfill,
    resolveMappedCoastTerrainInfillSteps,
    selectMappedSeaFeatures,
    simplifyClosedRing,
} from '../core/coastline-mask.js';

const mappedWater = [{
    outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
    holes: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]],
}];

test('coast evidence search yields within a visit budget and cancels without a partial infill', () => {
    let time = 0, current = true;
    const coastline = { contains(x) { time += .05; return x >= 0; } };
    const options = { coastline, shoreSceneY: -.05, now: () => time, isCurrent: () => current,
        evidenceSceneYAtLocal(x) { time += .025; return x <= -60 ? 1 : null; } };
    const collar = { quads: [{ shoreA: [0,0], shoreB: [0,10], landA: [-4.5,0], landB: [-4.5,10] }], joins: [] };
    const steps = resolveMappedCoastTerrainInfillSteps(collar, options);
    let yields = 0, worst = 0, result;
    for (;;) {
        const start = time, next = steps.next(); worst = Math.max(worst, time - start);
        if (next.done) { result = next.value; break; } yields++;
    }
    assert.ok(yields >= 10); assert.ok(worst <= .8, `simulated visit cost ${worst}`);
    assert.equal(result.quads.length, 1);
    assert.ok(result.quads[0].landA[0] <= -60 && result.quads[0].landA[0] > -61);
    const cancelled = resolveMappedCoastTerrainInfillSteps(collar, options);
    assert.equal(cancelled.next().done, false); current = false;
    assert.throws(() => cancelled.next(), { code: 'ground-generation-stale' });
    const outline = buildMappedCoastLandCollarSteps(createMappedCoastline(mappedWater), {
        now: () => ++time, isCurrent: () => current });
    assert.throws(() => outline.next(), { code: 'ground-generation-stale' });
});

test('uses mapped vector water as one coastline authority, including land holes', () => {
    const coastline = createMappedCoastline(mappedWater);
    assert.equal(coastline.features.length, 1);
    assert.equal(coastline.contains(2, 2), true);
    assert.equal(coastline.contains(10, 10), false);
    assert.equal(coastline.contains(25, 10), false);
});

test('indexed containment stays correct across positive and negative edge buckets', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, -150], [10, -150], [10, 150], [0, 150], [0, -150]],
        holes: [[[3, -90], [7, -90], [7, 90], [3, 90], [3, -90]]],
    }]);
    for (const z of [-149, -128, -64, 0, 64, 128, 149]) {
        assert.equal(coastline.contains(1, z), true);
        assert.equal(coastline.contains(12, z), false);
    }
    for (const z of [-89, -64, 0, 64, 89]) assert.equal(coastline.contains(5, z), false);
});

test('unions overlapping mapped-water polygons instead of cancelling them', () => {
    const overlapping = [
        { outer: [[0, 0], [12, 0], [12, 12], [0, 12], [0, 0]], holes: [] },
        { outer: [[8, 0], [20, 0], [20, 12], [8, 12], [8, 0]], holes: [] },
    ];
    assert.equal(createMappedCoastline(overlapping).contains(10, 6), true);
});

test('rejects malformed rings before they reach the mask renderer', () => {
    const coastline = createMappedCoastline([
        null,
        { outer: [[0, 0], [1, 1]], holes: [] },
        {
            outer: mappedWater[0].outer,
            holes: [[[1, 1]], mappedWater[0].holes[0]],
        },
    ]);
    assert.equal(coastline.features.length, 1);
    assert.equal(coastline.features[0].rings.length, 2);
});

test('straightens sub-tolerance shoreline teeth while preserving the quay corners', () => {
    const ring = [
        [0, 0], [2, 0.7], [4, -0.6], [6, 0.8], [8, 0],
        [8, 10], [0, 10], [0, 0],
    ];
    const simplified = simplifyClosedRing(ring, 1);
    assert.deepEqual(simplified, [[0, 0], [8, 0], [8, 10], [0, 10], [0, 0]]);
});

test('preserves a meaningful pier beyond the shoreline render tolerance', () => {
    const ring = [
        [0, 0], [3, 0], [3, -5], [6, -5], [6, 0], [12, 0],
        [12, 10], [0, 10], [0, 0],
    ];
    const simplified = simplifyClosedRing(ring, 2);
    assert.ok(simplified.some(([, z]) => z === -5));
    const coastline = createMappedCoastline([{ outer: ring, holes: [] }], { simplifyToleranceM: 2 });
    assert.equal(coastline.contains(4.5, -2), true);
    assert.equal(coastline.contains(9, -2), false);
});

test('chooses one ocean authority over overlapping bay and strait copies', () => {
    const feature = (waterClass, x) => ({
        type: 'Feature',
        properties: { class: waterClass },
        geometry: {
            type: 'Polygon',
            coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]],
        },
    });
    const ocean = feature('ocean', 0);
    const selected = selectMappedSeaFeatures([
        feature('bay', 0.2), feature('strait', -0.2), ocean, feature('swimming_pool', 20),
    ]);
    assert.deepEqual(selected, [ocean]);
    assert.equal(selectMappedSeaFeatures([feature('bay', 0), feature('strait', 0)]).length, 1);

    const subtypeOcean = feature('physical', 2);
    subtypeOcean.properties.subtype = 'ocean';
    assert.deepEqual(selectMappedSeaFeatures([feature('bay', 0), subtypeOcean]), [subtypeOcean]);
});

test('does not promote inland pools, ponds, or generic water into the sea mask', () => {
    const feature = (waterClass, x) => ({
        type: 'Feature',
        properties: { class: waterClass },
        geometry: {
            type: 'Polygon',
            coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]],
        },
    });
    assert.deepEqual(selectMappedSeaFeatures([
        feature('water', 0),
        feature('pond', 2),
        feature('swimming_pool', 4),
        feature('reflecting_pool', 6),
    ]), []);
});

test('builds one continuous exact collar on the land side of a water ring', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
        holes: [],
    }]);
    const { quads, joins } = buildMappedCoastLandCollar(coastline, { widthM: 4, minimumWidthM: 1 });
    assert.equal(quads.length, 4);
    assert.equal(joins.length, 4);
    for (const quad of quads) {
        const landMidX = (quad.landA[0] + quad.landB[0]) * 0.5;
        const landMidZ = (quad.landA[1] + quad.landB[1]) * 0.5;
        assert.equal(coastline.contains(landMidX, landMidZ), false);
    }
    assert.ok(joins.every(({ shore, landPrevious, landNext }) => (
        !coastline.contains(
            (shore[0] + landPrevious[0] + landNext[0]) / 3,
            (shore[1] + landPrevious[1] + landNext[1]) / 3,
        )
    )));
    const bottom = quads.find(({ shoreA, shoreB }) => shoreA[1] === 0 && shoreB[1] === 0);
    assert.ok(bottom.landA[1] < 0 && bottom.landB[1] < 0);
});

test('puts a hole-ring collar into its land island rather than into water', () => {
    const coastline = createMappedCoastline(mappedWater);
    const { quads } = buildMappedCoastLandCollar(coastline, { widthM: 1, minimumWidthM: 0.25 });
    const holeBottom = quads.find(({ shoreA, shoreB }) => (
        shoreA[1] === 5 && shoreB[1] === 5
    ));
    assert.ok(holeBottom);
    const landMidX = (holeBottom.landA[0] + holeBottom.landB[0]) * 0.5;
    const landMidZ = (holeBottom.landA[1] + holeBottom.landB[1]) * 0.5;
    assert.equal(coastline.contains(landMidX, landMidZ), false);
    assert.ok(landMidZ > 5);
});

test('extends a mapped shoreline over DGU NoData to the nearest evidenced land', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
        holes: [],
    }]);
    const collar = {
        quads: [{
            shoreA: [5, 0],
            shoreB: [15, 0],
            landA: [5, -4],
            landB: [15, -4],
        }],
        joins: [],
    };
    const infill = resolveMappedCoastTerrainInfill(collar, {
        coastline,
        evidenceSceneYAtLocal: (_x, z) => z <= -30 ? 3 : null,
        shoreSceneY: -1.6,
        surfaceLiftM: 0.01,
        maxReachM: 64,
    });
    assert.equal(infill.quads.length, 1);
    assert.equal(infill.diagnostics.extendedRayCount, 2);
    assert.ok(infill.quads[0].landA[1] <= -30);
    assert.ok(infill.quads[0].landA[1] > -30.3,
        'binary refinement should stop close to the first evidenced DTM edge');
    assert.equal(infill.quads[0].landAY, 3.01);
    assert.equal(infill.quads[0].shoreAY, -1.6,
        'natural terrain must descend to the sea datum at the exact mapped shore');
});

test('never reaches across mapped water to borrow terrain from the opposite bank', () => {
    const coastline = createMappedCoastline([
        {
            outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
            holes: [],
        },
        {
            outer: [[0, -12], [20, -12], [20, -10], [0, -10], [0, -12]],
            holes: [],
        },
    ]);
    const infill = resolveMappedCoastTerrainInfill({
        quads: [{
            shoreA: [5, 0], shoreB: [15, 0], landA: [5, -4], landB: [15, -4],
        }],
        joins: [],
    }, {
        coastline,
        evidenceSceneYAtLocal: (_x, z) => z <= -20 ? 2 : null,
        shoreSceneY: -1.6,
        maxReachM: 64,
    });
    assert.equal(infill.quads.length, 0);
    assert.equal(infill.diagnostics.omittedQuadCount, 1);
    assert.equal(infill.diagnostics.extendedRayCount, 0);
});

test('one unresolved shoreline segment does not suppress evidenced neighbours', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]],
        holes: [],
    }]);
    const infill = resolveMappedCoastTerrainInfill({
        quads: [
            { shoreA: [2, 0], shoreB: [8, 0], landA: [2, -4], landB: [8, -4] },
            { shoreA: [22, 0], shoreB: [28, 0], landA: [22, -4], landB: [28, -4] },
        ],
        joins: [],
    }, {
        coastline,
        evidenceSceneYAtLocal: (x) => x < 20 ? 1 : null,
        shoreSceneY: -1.6,
        maxReachM: 32,
    });
    assert.equal(infill.quads.length, 1);
    assert.deepEqual(infill.quads[0].shoreA, [2, 0]);
    assert.equal(infill.diagnostics.omittedQuadCount, 1);
});

test('adaptive quads and corner joins reuse bit-identical resolved land vertices', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
        holes: [],
    }]);
    const sharedShore = [15, 0];
    const sharedLand = [15, -4];
    const infill = resolveMappedCoastTerrainInfill({
        quads: [{
            shoreA: [5, 0], shoreB: sharedShore, landA: [5, -4], landB: sharedLand,
        }],
        joins: [{
            shore: sharedShore,
            landPrevious: sharedLand,
            landNext: [16, -4],
        }],
    }, {
        coastline,
        evidenceSceneYAtLocal: (_x, z) => z <= -8 ? 1 : null,
        shoreSceneY: -1.6,
        maxReachM: 32,
    });
    assert.equal(infill.quads.length, 1);
    assert.equal(infill.joins.length, 1);
    assert.strictEqual(infill.quads[0].landB, infill.joins[0].landPrevious);
});

test('fills a bounded missing DGU run from adjacent evidenced coast rays', () => {
    const coastline = createMappedCoastline([{
        outer: [[0, 0], [30, 0], [30, 20], [0, 20], [0, 0]],
        holes: [],
    }]);
    const shore = x => [x, 0];
    const land = x => [x, -4];
    const infill = resolveMappedCoastTerrainInfill({
        quads: [
            { shoreA: shore(2), shoreB: shore(8), landA: land(2), landB: land(8) },
            { shoreA: shore(8), shoreB: shore(14), landA: land(8), landB: land(14) },
            { shoreA: shore(14), shoreB: shore(20), landA: land(14), landB: land(20) },
        ],
        joins: [],
    }, {
        coastline,
        evidenceSceneYAtLocal: (x, z) => (
            z <= -4 && (x <= 2 || x >= 20) ? (x <= 2 ? 1 : 3) : null
        ),
        shoreSceneY: -1.6,
        maxInferenceSpanM: 64,
    });

    assert.equal(infill.quads.length, 3);
    assert.equal(infill.diagnostics.inferredRayCount, 2);
    assert.equal(infill.diagnostics.unresolvedRayCount, 0);
    assert.equal(infill.diagnostics.omittedQuadCount, 0);
    assert.ok(infill.quads[1].landAY > 1 && infill.quads[1].landAY < 3);
    assert.ok(infill.quads[1].landBY > infill.quads[1].landAY);
});

test('terrain cutout yields the full shoreline transition but preserves an inner overlap', () => {
    const sharedShore = [10, 0];
    const sharedLand = [10, -8];
    const cutout = buildMappedCoastTerrainCutout({
        quads: [{
            shoreA: [2, 0],
            shoreB: sharedShore,
            landA: [2, -4],
            landB: sharedLand,
        }],
        joins: [{
            shore: sharedShore,
            landPrevious: sharedLand,
            landNext: [14, -8],
        }],
    }, { innerOverlapM: 0.75 });

    assert.deepEqual(cutout.quads[0], {
        shoreA: [2, 0],
        shoreB: sharedShore,
        landA: [2, -3.25],
        landB: [10, -7.25],
    });
    assert.deepEqual(cutout.joins[0].landPrevious, [10, -7.25]);
    assert.ok(Math.abs(
        Math.hypot(
            cutout.joins[0].landNext[0] - sharedShore[0],
            cutout.joins[0].landNext[1] - sharedShore[1],
        ) - (Math.hypot(4, -8) - 0.75),
    ) < 1e-9);
});

test('terrain cutout omits a transition too narrow to retain its required overlap', () => {
    const cutout = buildMappedCoastTerrainCutout({
        quads: [{
            shoreA: [0, 0], shoreB: [1, 0], landA: [0, -0.5], landB: [1, -0.5],
        }],
        joins: [],
    }, { innerOverlapM: 0.75 });
    assert.deepEqual(cutout, { quads: [], joins: [] });
});

test('samples the exact triangulated coast replacement seen by civil solvers', () => {
    const sampler = createMappedCoastTerrainSurfaceSampler(new Float32Array([
        0, 0, 0, 10, 10, 0, 0, 10, 10,
        10, 10, 0, 10, 20, 10, 0, 10, 10,
    ]), { bucketSizeM: 4 });

    assert.ok(sampler);
    assert.equal(sampler.triangleCount, 2);
    assert.deepEqual(sampler.bounds, { minX: 0, minZ: 0, maxX: 10, maxZ: 10 });
    assert.ok(Math.abs(sampler(2, 3) - 5) < 1e-9);
    assert.ok(Math.abs(sampler(8, 7) - 15) < 1e-9);
    assert.equal(sampler(-0.1, 5), null);
    assert.equal(sampler(5, 10.1), null);
});

test('coast sampler chooses the visible upper triangle where replacements overlap', () => {
    const sampler = createMappedCoastTerrainSurfaceSampler([
        0, 1, 0, 4, 1, 0, 0, 1, 4,
        0, 3, 0, 4, 3, 0, 0, 3, 4,
    ]);
    assert.equal(sampler(1, 1), 3);
});
