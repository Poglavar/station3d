// Locks structural tram pairing, its single full-width walk surface, and the
// road-bridge envelope that keeps deck edges and fences outside the corridor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import {
    buildRailTrackbedSupportIndexResumable,
    canonicalizeStructuralTramCorridors,
    createStructuralTramCorridorEnvelopeIndex,
    createStructuralTramTrackbedSupportIndex,
    isStructuralOsmTramFeature,
    railTrackbedSurfaceQuads,
    structuralTramTrackbedSurfaceQuads,
} from '../core/structural-tram-corridor.js';

const ANCHOR_LAT = 45.78;
const ANCHOR_LON = 16;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z = 0) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function tramFeature(osmId, x, z1, z2, tags = {}, properties = {}) {
    return {
        type: 'Feature',
        properties: {
            osmId,
            railway_type: 'tram',
            tags: { railway: 'tram', gauge: '1000', ...tags },
            ...properties,
        },
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(x, z1), lonLat(x, z2)],
        },
    };
}

function tramSegment(osmId, x, z1, z2, y = 7, tags = {}, properties = {}) {
    const direction = Math.sign(z2 - z1) || 1;
    const feature = tramFeature(osmId, x, z1, z2, tags, properties);
    return {
        x1: x,
        yStart: y,
        z1,
        x2: x,
        yEnd: y,
        z2,
        cx: x,
        cz: (z1 + z2) * 0.5,
        len: Math.abs(z2 - z1),
        gaugeM: 1,
        startTrackCenterOffsetsM: [0],
        endTrackCenterOffsetsM: [0],
        startTrackbedHalfWidthM: 1.05,
        endTrackbedHalfWidthM: 1.05,
        startTrackbedInnerEdgeM: 0,
        endTrackbedInnerEdgeM: 0,
        startJoinX: direction,
        startJoinZ: 0,
        endJoinX: direction,
        endJoinZ: 0,
        angle: direction > 0 ? 0 : Math.PI,
        feature,
        properties: feature.properties,
        sortKey: `${osmId}:${z1}`,
    };
}

test('a mapped structural pair becomes one canonical two-track corridor', () => {
    const source = [
        tramSegment('10', -1.8, 0, 20, 7, { bridge: 'yes', layer: '1' }),
        tramSegment('20', 1.8, 20, 0, 7, { bridge: 'yes', layer: '1' }),
    ];

    const result = canonicalizeStructuralTramCorridors(source, {
        targetCenterSpacingM: 2.8,
    });

    assert.equal(result.length, 1);
    const [corridor] = result;
    assert.ok(Math.abs(corridor.x1) < 1e-9);
    assert.ok(Math.abs(corridor.x2) < 1e-9);
    assert.deepEqual(corridor.startTrackCenterOffsetsM, [-1.4, 1.4]);
    assert.deepEqual(corridor.endTrackCenterOffsetsM, [-1.4, 1.4]);
    assert.ok(Math.abs(corridor.startTrackbedHalfWidthM - 2.45) < 1e-9);
    assert.ok(Math.abs(corridor.endTrackbedHalfWidthM - 2.45) < 1e-9);
    assert.equal(corridor.startTrackbedInnerEdgeM, 0);
    assert.equal(corridor.feature.properties.trackCount, 2);
    assert.equal(corridor.feature.properties.trackArrangement, 'together');
    assert.deepEqual(corridor.pairedSourceOsmIds, ['10', '20']);
    assert.equal(source[0].x1, -1.8, 'source geometry stays immutable');
    assert.equal(source[1].x1, 1.8, 'source geometry stays immutable');
});

test('ordinary, crossing, vertically separate, and authored tracks do not pair', () => {
    const ordinary = [
        tramSegment('10', -1.8, 0, 20),
        tramSegment('20', 1.8, 20, 0),
    ];
    assert.equal(canonicalizeStructuralTramCorridors(ordinary), ordinary);

    const longitudinal = tramSegment('30', -1.8, 0, 20, 7, { bridge: 'yes' });
    const crossing = {
        ...tramSegment('40', 0, 0, 20, 7, { bridge: 'yes' }),
        x1: -5,
        z1: 10,
        x2: 5,
        z2: 10,
    };
    assert.deepEqual(
        canonicalizeStructuralTramCorridors([longitudinal, crossing]),
        [longitudinal, crossing],
    );

    const overhead = tramSegment('50', 1.8, 20, 0, 12, { bridge: 'yes' });
    assert.deepEqual(
        canonicalizeStructuralTramCorridors([longitudinal, overhead]),
        [longitudinal, overhead],
    );

    const authored = tramSegment(
        '60',
        1.8,
        20,
        0,
        7,
        { bridge: 'yes' },
        { source: 'user' },
    );
    assert.deepEqual(
        canonicalizeStructuralTramCorridors([longitudinal, authored]),
        [longitudinal, authored],
    );
});

test('one structural surface supports both rails and the space between them', () => {
    const segments = canonicalizeStructuralTramCorridors([
        tramSegment('10', -1.8, 0, 20, 7, { bridge: 'yes' }),
        tramSegment('20', 1.8, 20, 0, 7, { bridge: 'yes' }),
    ], { targetCenterSpacingM: 2.8 });
    const quads = structuralTramTrackbedSurfaceQuads(segments, {
        surfaceYOffsetM: 0.075,
    });
    const support = createStructuralTramTrackbedSupportIndex(quads);

    assert.equal(quads.length, 1);
    assert.equal(support.size, 1);
    assert.ok(Math.abs(support.supportYAtLocal(-1.4, 10) - 7.075) < 1e-9);
    assert.ok(Math.abs(support.supportYAtLocal(0, 10) - 7.075) < 1e-9);
    assert.ok(Math.abs(support.supportYAtLocal(1.4, 10) - 7.075) < 1e-9);
    assert.equal(support.supportYAtLocal(3, 10), null);
    assert.deepEqual(
        structuralTramTrackbedSurfaceQuads([
            tramSegment('30', 0, 0, 20),
        ]),
        [],
        'ground-level tram keeps using the road or terrain as its floor',
    );
});

test('the generic rail floor also makes ordinary smooth trackbed firm', () => {
    const quads = railTrackbedSurfaceQuads([
        tramSegment('30', 0, 0, 20, 3),
    ], { surfaceYOffsetM: 0.075 });
    const support = createStructuralTramTrackbedSupportIndex(quads);

    assert.equal(quads.length, 1);
    assert.ok(Math.abs(support.supportYAtLocal(0, 10) - 3.075) < 1e-9);
    assert.equal(support.supportYAtLocal(2, 10), null);
});

test('the cooperative rail support build matches the synchronous index', () => {
    const segments = [
        tramSegment('30', 0, 0, 20, 3),
        tramSegment('31', 2, 0, 20, 4),
    ];
    const expected = createStructuralTramTrackbedSupportIndex(
        railTrackbedSurfaceQuads(segments, { surfaceYOffsetM: 0.075 }),
    );
    const build = buildRailTrackbedSupportIndexResumable(segments, {
        surfaceYOffsetM: 0.075,
    });
    let yields = 0;
    let outcome = build.next();
    while (!outcome.done) {
        yields += 1;
        outcome = build.next();
    }

    assert.equal(yields, segments.length, 'one resumable unit is one solved chord');
    assert.equal(outcome.value.size, expected.size);
    for (const [x, z] of [[0, 10], [2, 10], [10, 10]]) {
        assert.equal(
            outcome.value.supportYAtLocal(x, z),
            expected.supportYAtLocal(x, z),
        );
    }
});

test('a tram support query keeps plan-crossing rail levels separate by OSM way', () => {
    const lowerTram = tramSegment('tram-lower', 0, 0, 20, 1);
    const upperRail = {
        ...tramSegment('rail-upper', 0, 0, 20, 7),
        x1: -10,
        z1: 10,
        x2: 10,
        z2: 10,
        startJoinX: 0,
        startJoinZ: -1,
        endJoinX: 0,
        endJoinZ: -1,
    };
    const support = createStructuralTramTrackbedSupportIndex(
        railTrackbedSurfaceQuads([lowerTram, upperRail], { surfaceYOffsetM: 0.075 }),
    );

    assert.ok(Math.abs(support.supportYAtLocal(0, 10) - 7.075) < 1e-9,
        'unqualified walk support still sees the highest surface');
    assert.ok(Math.abs(support.supportYAtLocal(0, 10, { osmId: 'tram-lower' }) - 1.075) < 1e-9,
        'ambient tram stays on its own lower way');
    assert.ok(Math.abs(support.supportYAtLocal(0, 10, { osmId: 'rail-upper' }) - 7.075) < 1e-9);
    assert.equal(support.supportYAtLocal(0, 10, { osmId: 'missing' }), null);
});

test('a road bridge envelope includes structural tram but ignores unrelated track', () => {
    const index = createStructuralTramCorridorEnvelopeIndex([
        tramFeature('10', -4.2, 0, 20, { bridge: 'yes' }),
        tramFeature('20', 3.6, 0, 20, { embankment: 'yes' }),
        tramFeature('30', 8, 0, 20),
        tramFeature('40', 10, 0, 20, { bridge: 'yes' }, { source: 'user' }),
    ], {
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        halfWidthForFeature: () => 1.05,
    });

    const offsets = index.formationOffsetsAtLocal(
        0,
        10,
        { x: 0, z: 1 },
        { leftM: 3, rightM: 3 },
    );

    assert.equal(index.size, 2);
    assert.ok(Math.abs(offsets.leftM - 5.75) < 1e-6);
    assert.ok(Math.abs(offsets.rightM - 5.15) < 1e-6);
    assert.deepEqual(
        index.formationOffsetsAtLocal(
            0,
            10,
            { x: 1, z: 0 },
            { leftM: 3, rightM: 3 },
        ),
        { leftM: 3, rightM: 3 },
        'transverse track is a crossing, not part of this deck envelope',
    );
});

test('structural tagging and renderer wiring stay scoped to carried OSM tram', () => {
    assert.equal(isStructuralOsmTramFeature(tramFeature('10', 0, 0, 1, {
        bridge: 'yes',
    })), true);
    assert.equal(isStructuralOsmTramFeature(tramFeature('20', 0, 0, 1, {
        layer: '1',
    })), true);
    assert.equal(isStructuralOsmTramFeature(tramFeature('30', 0, 0, 1)), false);
    assert.equal(isStructuralOsmTramFeature(tramFeature(
        '40',
        0,
        0,
        1,
        { bridge: 'yes' },
        { source: 'user' },
    )), false);

    const railsSource = readFileSync(
        new URL('../world/rails.js', import.meta.url),
        'utf8',
    );
    assert.match(railsSource, /canonicalizeStructuralTramCorridors\(segments/);
    assert.match(railsSource, /buildRailTrackbedSupportIndexResumable\(candidate\.segments/);
    assert.match(railsSource, /stepPendingRailFormationModel\(\)/);
    assert.doesNotMatch(railsSource, /pairedTramTrackbedFillQuads/);
});
