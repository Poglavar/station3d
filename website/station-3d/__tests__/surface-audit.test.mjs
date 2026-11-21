// Locks the ground-surface audit: plan triangle lookup, stencil replay and the
// hierarchy violations it reports (inversion, coplanar, floating, void, duplicate).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SURFACE_AUDIT_VIOLATION,
    auditSurfaceLevelLadder,
    buildPlanTriangleIndex,
    classifySurfaceStack,
    depthResolutionM,
    planTriangleHitsAt,
    summarizeSurfaceAudit,
} from '../core/surface-audit.js';

// Same-level class pairs whose compiled heights are under 3 mm apart (or
// inverted) with no stencil relation deciding them, as of 2026-09-11. Depth
// alone cannot honour their rank, so tessellation and polygon offset pick the
// winner. This list may only shrink: fix a pair, then delete its line.
const KNOWN_DEPTH_DECIDED_LADDER_PAIRS = new Set([
    'level-crossing-dressing>road-marking',
    'rail-trackbed-curb>road-marking',
    'rail-trackbed>level-crossing-apron',
    'level-crossing-apron>road-marking',
    'construction>parking-marking',
    'parking-marking>parking',
    'cycleway>pedestrian-edging',
    'sidewalk>buffered-sidewalk',
    'tram-corridor>buffered-sidewalk',
    'passive-edging>buffered-sidewalk',
]);
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    surfaceStencilContract,
} from '../core/surface-hierarchy.js';

const claim = (surfaceClass, extra = {}) => compileSurfaceClaim({
    surfaceClass,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ...extra,
});

const surface = (surfaceClass, y, extra = {}) => {
    const surfaceClaim = claim(surfaceClass, extra.claim);
    return {
        y,
        claim: surfaceClaim,
        renderOrder: surfaceClaim.technical.renderOrder ?? 0,
        stencil: surfaceStencilContract(surfaceClaim),
        colorWrite: true,
        culled: false,
        discarded: false,
        ...extra.hit,
    };
};

const types = result => result.violations.map(entry => entry.type);

test('plan index interpolates height, skips vertical faces and dedupes shared edges', () => {
    // A 2 m square ramp whose height equals x.
    const positions = new Float32Array([
        0, 0, 0,
        2, 2, 0,
        0, 0, 2,
        2, 2, 2,
        // Vertical sliver: no plan area.
        5, 0, 0,
        5, 3, 0,
        6, 0, 0,
    ]);
    const index = new Uint16Array([0, 1, 2, 2, 1, 3]);
    const plan = buildPlanTriangleIndex({ positions, index });
    assert.equal(plan.triangleCount, 2);
    const centre = planTriangleHitsAt(plan, 1, 1);
    assert.equal(centre.length, 1, 'a point on the shared diagonal is one surface');
    assert.ok(Math.abs(centre[0].y - 1) < 1e-9);
    assert.equal(planTriangleHitsAt(plan, 3, 1).length, 0);

    const wall = buildPlanTriangleIndex({ positions, index: new Uint16Array([4, 5, 6]) });
    assert.equal(wall.triangleCount, 0, 'a wall standing in the XY plane has no plan area');
});

test('plan index applies the world matrix and the query bounds', () => {
    const positions = new Float32Array([0, 0, 0, 4, 0, 0, 0, 0, 4]);
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 5, -3, 1];
    const plan = buildPlanTriangleIndex({ positions, matrix: translate });
    const hits = planTriangleHitsAt(plan, 11, -2);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].y, 5);
    const far = buildPlanTriangleIndex({
        positions,
        matrix: translate,
        bounds: { minX: 100, maxX: 110, minZ: 100, maxZ: 110 },
    });
    assert.equal(far.triangleCount, 0);
});

test('depth resolution grows with the square of distance', () => {
    assert.ok(Math.abs(depthResolutionM(150, 0.5) - 22500 / (0.5 * 2 ** 24)) < 1e-12);
    assert.equal(depthResolutionM(150, 0), null);
});

test('Jelačić: terrain 4.3 cm above published paving is an inversion', () => {
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.2),
        surface(SURFACE_CLASS.SIDEWALK, 1.157),
    ]);
    assert.deepEqual(types(result), [SURFACE_AUDIT_VIOLATION.INVERSION]);
    const [inversion] = result.violations;
    assert.equal(inversion.upperClass, SURFACE_CLASS.TERRAIN);
    assert.equal(inversion.lowerClass, SURFACE_CLASS.SIDEWALK);
    assert.equal(inversion.cause, 'depth');
    assert.equal(inversion.gapM, 0.043);
});

test('paving above terrain by its level is clean', () => {
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.2),
        surface(SURFACE_CLASS.SIDEWALK, 1.243),
    ]);
    assert.deepEqual(result.violations, []);
});

test('a road drawn over a cycleway is an inversion', () => {
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.0),
        surface(SURFACE_CLASS.ROAD_CARRIAGEWAY, 1.10),
        surface(SURFACE_CLASS.CYCLEWAY, 1.08),
    ]);
    assert.deepEqual(types(result), [SURFACE_AUDIT_VIOLATION.INVERSION]);
    assert.equal(result.violations[0].upperClass, SURFACE_CLASS.ROAD_CARRIAGEWAY);
    assert.equal(result.violations[0].lowerClass, SURFACE_CLASS.CYCLEWAY);
});

test('a winner separated by less than the depth resolution is coplanar', () => {
    const above = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.2),
        surface(SURFACE_CLASS.SIDEWALK, 1.2012),
    ], { coplanarGapM: 0.002 });
    assert.deepEqual(types(above), [SURFACE_AUDIT_VIOLATION.COPLANAR]);
    const belowWithinTolerance = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.2),
        surface(SURFACE_CLASS.SIDEWALK, 1.195),
    ], { inversionToleranceM: 0.01 });
    assert.deepEqual(types(belowWithinTolerance), [SURFACE_AUDIT_VIOLATION.COPLANAR]);
});

test('terrain discarded by a formation cutout is not an inversion, and nothing visible is void', () => {
    const cut = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 3.0, { hit: { discarded: true } }),
        surface(SURFACE_CLASS.ROAD_CARRIAGEWAY, 1.0),
    ]);
    assert.deepEqual(cut.violations, []);
    const hole = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 3.0, { hit: { discarded: true } }),
    ], { terrainCovered: true });
    assert.deepEqual(types(hole), [SURFACE_AUDIT_VIOLATION.VOID]);
    const unclaimedCover = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 3.0, { hit: { discarded: true } }),
    ], { terrainCovered: true, unclaimedVisible: true });
    assert.deepEqual(types(unclaimedCover), [SURFACE_AUDIT_VIOLATION.VOID],
        'an unclaimed roof cannot certify ground coverage');
});

test('grade-separated surfaces are never rank-compared', () => {
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.ROAD_CARRIAGEWAY, 1.0),
        surface(SURFACE_CLASS.TERRAIN, 0.98),
        surface(SURFACE_CLASS.TERRAIN, 9.0, {
            claim: { verticalBand: 'hill-over-underpass', verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED },
        }),
        surface(SURFACE_CLASS.SIDEWALK, 7.0, {
            claim: { verticalBand: 'deck:bridge-1', verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED },
        }),
    ]);
    assert.deepEqual(result.violations, []);
});

test('rank still applies within the same elevated deck', () => {
    const deck = { verticalBand: 'deck:1', verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED };
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 0),
        surface(SURFACE_CLASS.ROAD_CARRIAGEWAY, 5.2, { claim: deck }),
        surface(SURFACE_CLASS.SIDEWALK, 5, { claim: deck }),
    ]);
    assert.deepEqual(types(result), ['inversion']);
    assert.equal(result.violations[0].band, 'deck:1');
});

test('discarding or disabling expected paint cannot make its conflict disappear', () => {
    for (const hidden of [{ discarded: true }, { colorWrite: false }, { culled: true }]) {
        const result = classifySurfaceStack([
            surface(SURFACE_CLASS.TERRAIN, 1),
            surface(SURFACE_CLASS.SIDEWALK, 1.043, { hit: hidden }),
        ]);
        assert.deepEqual(types(result), ['inversion']);
        assert.ok(['discard', 'color-write', 'culling'].includes(result.violations[0].cause));
    }
});

test('independent expected coverage finds a missing producer', () => {
    const terrain = surface(SURFACE_CLASS.TERRAIN, 1);
    const paving = surface(SURFACE_CLASS.SIDEWALK, 1.043, {
        claim: { ownerId: 'paving:source-1' },
    });
    const result = classifySurfaceStack([terrain], { expectedHits: [terrain, paving] });
    assert.deepEqual(types(result), ['inversion']);
    assert.equal(result.violations[0].cause, 'missing-paint');
    assert.equal(result.coverage.expectedPaint, true);
    const absent = classifySurfaceStack([], { expectedHits: [paving] });
    assert.deepEqual(types(absent), ['missing-paint']);
});

test('only an explicit intentional opening may waive loaded ground coverage', () => {
    assert.deepEqual(types(classifySurfaceStack([], { terrainCovered: true })), ['void']);
    assert.deepEqual(classifySurfaceStack([], {
        terrainCovered: true, intentionalOpening: true,
    }).violations, []);
    assert.deepEqual(types(classifySurfaceStack([
        surface(SURFACE_CLASS.STRUCTURE, 5),
    ], { terrainCovered: true })), ['void']);
});

test('a firm sheet hanging over visible ground is floating', () => {
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 0),
        surface(SURFACE_CLASS.BUFFERED_SIDEWALK, 2.1),
    ]);
    assert.deepEqual(types(result), [SURFACE_AUDIT_VIOLATION.FLOATING]);
    assert.equal(result.violations[0].gapM, 2.1);
});

test('stencil replay: a hidden reader is not a winner, a hidden winner is an inversion', () => {
    const writer = { enabled: true, ref: 1, funcMask: 0, writeMask: 1, compare: 'always', zPass: 'replace' };
    const reader = { enabled: true, ref: 0, funcMask: 1, writeMask: 0, compare: 'equal', zPass: 'keep' };
    const hiddenLanduse = classifySurfaceStack([
        surface(SURFACE_CLASS.ROAD_CARRIAGEWAY, 1.00, { hit: { renderOrder: -10, stencil: writer } }),
        surface(SURFACE_CLASS.PASSIVE_LANDUSE, 1.02, { hit: { renderOrder: 0, stencil: reader } }),
    ]);
    assert.deepEqual(hiddenLanduse.violations, [], 'landuse above the road is cut by the road bit');

    const hiddenWinner = classifySurfaceStack([
        surface(SURFACE_CLASS.PASSIVE_LANDUSE, 1.00, { hit: { renderOrder: -10, stencil: writer } }),
        surface(SURFACE_CLASS.SIDEWALK, 1.05, { hit: { renderOrder: 0, stencil: reader } }),
    ]);
    assert.deepEqual(types(hiddenWinner), [SURFACE_AUDIT_VIOLATION.INVERSION]);
    assert.equal(hiddenWinner.violations[0].cause, 'stencil');
});

test('the same feature published twice at one height is a duplicate', () => {
    const copy = key => surface(SURFACE_CLASS.SIDEWALK, 1.157, {
        claim: { featureId: '-1493356001' },
        hit: { publicationKey: key },
    });
    const result = classifySurfaceStack([
        surface(SURFACE_CLASS.TERRAIN, 1.0),
        copy('roads:aggregate:r0_0'),
        copy('roads:aggregate:r0_-1'),
        copy('roads:aggregate:r-1_0'),
    ]);
    assert.deepEqual(types(result), [SURFACE_AUDIT_VIOLATION.DUPLICATE]);
    assert.equal(result.violations[0].copies, 3);
});

test('equal-rank top copies cannot hide a coplanar conflict with a lower rank', () => {
    const ground = surface(SURFACE_CLASS.TERRAIN, 1);
    const first = surface(SURFACE_CLASS.SIDEWALK, 1.001, {
        claim: { featureId: 'paving' }, hit: { publicationKey: 'region-a' },
    });
    for (const id of ['paving', 'another-paving']) {
        const second = surface(SURFACE_CLASS.SIDEWALK, 1.001, {
            claim: { featureId: id }, hit: { publicationKey: 'region-b' },
        });
        for (const upper of [[first, second], [second, first], [first]]) {
            const result = classifySurfaceStack([ground, ...upper]);
            assert.equal(result.violations.filter(item => item.type === SURFACE_AUDIT_VIOLATION.COPLANAR).length, 1);
        }
    }
});

test('ladder: no new same-level pair is left for depth to decide', () => {
    const { pairs } = auditSurfaceLevelLadder({ minimumGapM: 0.003 });
    const depthDecided = pairs
        .filter(pair => !pair.stencilArbitrated)
        .map(pair => `${pair.upperClass}>${pair.lowerClass}`);
    const unexpected = depthDecided.filter(key => !KNOWN_DEPTH_DECIDED_LADDER_PAIRS.has(key));
    assert.deepEqual(unexpected, [], 'new rank pairs too close to resolve by depth');
    const fixed = [...KNOWN_DEPTH_DECIDED_LADDER_PAIRS].filter(key => !depthDecided.includes(key));
    assert.deepEqual(fixed, [], 'a known pair is fixed: delete it from KNOWN_DEPTH_DECIDED_LADDER_PAIRS');
});

test('ladder: stencil arbitration is recognised for carriageway over buffered sidewalk', () => {
    const { pairs } = auditSurfaceLevelLadder({ minimumGapM: 0.003 });
    const carriageway = pairs.find(pair => pair.upperClass === SURFACE_CLASS.ROAD_CARRIAGEWAY
        && pair.lowerClass === SURFACE_CLASS.BUFFERED_SIDEWALK);
    assert.ok(carriageway, 'the buffered sidewalk sits 23 mm above the carriageway by design');
    assert.equal(carriageway.kind, 'inverted');
    assert.equal(carriageway.stencilArbitrated, true);
});

test('summary groups violations by pair and keeps the worst example', () => {
    const inversion = gapM => ({
        type: SURFACE_AUDIT_VIOLATION.INVERSION,
        cause: 'depth',
        upperClass: SURFACE_CLASS.TERRAIN,
        lowerClass: SURFACE_CLASS.SIDEWALK,
        gapM,
    });
    const summary = summarizeSurfaceAudit([
        { x: 1, z: 2, violations: [inversion(0.043)] },
        { x: 3, z: 4, violations: [inversion(0.08)] },
    ], { stepM: 0.5, sampleCount: 400 });
    assert.equal(summary.sampleCount, 400);
    assert.equal(summary.violatingSamples, 2);
    assert.equal(summary.byType.inversion, 2);
    assert.equal(summary.pairs.length, 1);
    assert.equal(summary.pairs[0].samples, 2);
    assert.equal(summary.pairs[0].areaM2, 0.5);
    assert.equal(summary.pairs[0].worstGapM, 0.08);
    assert.equal(summary.pairs[0].worst.x, 3);
});
