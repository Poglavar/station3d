// A track's third coordinate is only a LEVEL — metres above the local ground —
// in the relative regime. Under an absolute/asl datum it is a sea-level height,
// and the two are indistinguishable as bare numbers: "2.44" is a low deck in one
// regime and a bore under a hill in the other.
//
// Sibenik project 141 is the second: the alignment runs 2.44 m above the
// Adriatic beneath 14.5 m of rock. Read as a level, `max(elev) > 0.05` made it
// an elevated deck, so courtyard-passages cut a band from just above the ground
// to the sky along the whole bore and every building over it lost its walls —
// 42.75% of the frame, on ground the demolition rule had correctly spared.
// Decor read the same number and culled every tree under the phantom deck.
//
// The other half of the same fault: a 2D coordinate has no level at all, and
// `Number(undefined) || 0` called that "lying exactly at grade" — the most
// destructive verdict available, reached by an absent measurement.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLowElevatedRampVolumes,
    buildTrackCorridorVolumes,
    hasRelativeElevations,
    isPlannerElevatedSegment,
    isPlannerSurfaceLevelSegment,
    isPlannerSurfaceOpenCutSegment,
    isPlannerUndergroundRampSegment,
} from '../world/track-corridors.js';

const ANCHOR_LAT = 43.731;
const ANCHOR_LON = 15.896;

// ~14 m of easting per 0.00017 deg of longitude here: long enough that every
// segment clears the builder's minimum length.
function trackFeature(levels, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: {
            type: 'LineString',
            coordinates: levels.map((level, index) => (level === null
                ? [ANCHOR_LON + index * 0.00017, ANCHOR_LAT]
                : [ANCHOR_LON + index * 0.00017, ANCHOR_LAT, level])),
        },
    };
}

const ABSOLUTE = { elevationMode: 'absolute', elevationDatum: 'EVRF2000' };
const ASL = { elevationDatum: 'asl' };

function elevatedVolumes(feature) {
    return buildTrackCorridorVolumes([feature], ANCHOR_LAT, ANCHOR_LON, {
        segmentFilter: ({ startElevationM, endElevationM }) =>
            isPlannerElevatedSegment(startElevationM, endElevationM),
    });
}

function surfaceVolumes(feature) {
    return buildTrackCorridorVolumes([feature], ANCHOR_LAT, ANCHOR_LON, {
        segmentFilter: ({ startElevationM, endElevationM }) =>
            isPlannerSurfaceLevelSegment(startElevationM, endElevationM),
    });
}

// ── Which regime a feature is in ───────────────────────────────────────────

test('only an untagged feature carries levels above the ground', () => {
    assert.equal(hasRelativeElevations({}), true);
    assert.equal(hasRelativeElevations({ trackId: 1 }), true);
    assert.equal(hasRelativeElevations(ABSOLUTE), false);
    assert.equal(hasRelativeElevations(ASL), false);
    assert.equal(hasRelativeElevations(undefined), true);
});

// ── The regression ─────────────────────────────────────────────────────────

test('a bore 2.44 m above the sea is not a deck 2.44 m above the street', () => {
    const bore = trackFeature([2.44, 2.44, 2.44], ABSOLUTE);
    assert.deepEqual(elevatedVolumes(bore), [],
        'an absolute height must not classify as an elevated deck');
    assert.deepEqual(surfaceVolumes(bore), [],
        'nor as a track lying at grade');
});

test('the same numbers in the relative regime still build a deck', () => {
    // The guard must be about the DATUM, not about the magnitude — otherwise it
    // would also stop cutting real low viaducts.
    const deck = trackFeature([2.44, 2.44, 2.44]);
    assert.equal(elevatedVolumes(deck).length, 2);
});

test('an absolute feature hands out no levels at all', () => {
    const [volume] = buildTrackCorridorVolumes(
        [trackFeature([2.44, 3.01], ABSOLUTE)], ANCHOR_LAT, ANCHOR_LON, {},
    );
    assert.equal(volume.startElevationM, null);
    assert.equal(volume.endElevationM, null);
});

test('an absolute height does not lift the corridor off the caller plane', () => {
    // centerY: 0 means "the caller placed this band"; adding 2.7 m of sea-level
    // height to it moved the band by a distance that means nothing here.
    const [absolute] = buildTrackCorridorVolumes(
        [trackFeature([2.44, 3.01], ABSOLUTE)], ANCHOR_LAT, ANCHOR_LON, { centerY: 0 },
    );
    const [relative] = buildTrackCorridorVolumes(
        [trackFeature([2.44, 3.01])], ANCHOR_LAT, ANCHOR_LON, { centerY: 0 },
    );
    assert.equal(absolute.centerY, 0);
    assert.ok(Math.abs(relative.centerY - 2.725) < 1e-6, `got ${relative.centerY}`);
});

test('an absolute height grows no emergency walkway beside it', () => {
    const [absolute] = buildTrackCorridorVolumes(
        [trackFeature([6, 6], ABSOLUTE)], ANCHOR_LAT, ANCHOR_LON, {},
    );
    const [relative] = buildTrackCorridorVolumes(
        [trackFeature([6, 6])], ANCHOR_LAT, ANCHOR_LON, {},
    );
    assert.ok(relative.halfWidth > absolute.halfWidth + 1,
        `a relative +6 deck widens (${relative.halfWidth}) past the absolute one (${absolute.halfWidth})`);
});

test('an asl datum is treated exactly like an absolute one', () => {
    assert.deepEqual(elevatedVolumes(trackFeature([2.44, 2.44, 2.44], ASL)), []);
});

// ── A missing level is not level zero ──────────────────────────────────────

test('a 2D line is not a track lying at grade', () => {
    assert.deepEqual(surfaceVolumes(trackFeature([null, null, null])), [],
        'no third coordinate means unknown, and unknown demolishes nothing');
});

test('one missing level does not classify its whole segment', () => {
    // The first segment (0 → unknown) is unclassifiable; the second is a real
    // at-grade pair and must still be found, so this cannot pass by refusing
    // to classify anything.
    const volumes = surfaceVolumes(trackFeature([0, null, 0, 0]));
    assert.equal(volumes.length, 1);
});

// ── The low-clearance ramp volumes read the same coordinates ───────────────

test('a rising deck still reserves the low-clearance space beneath it', () => {
    const rising = buildLowElevatedRampVolumes(
        [trackFeature([0, 3, 6])], ANCHOR_LAT, ANCHOR_LON,
    );
    assert.ok(rising.length > 0, 'a real +1 ramp must still block the space under its low end');
});

test('no ramp rises out of an absolute height or a missing one', () => {
    assert.deepEqual(
        buildLowElevatedRampVolumes([trackFeature([0, 3, 6], ABSOLUTE)], ANCHOR_LAT, ANCHOR_LON),
        [], 'sea-level heights are not deck heights');
    assert.deepEqual(
        buildLowElevatedRampVolumes([trackFeature([null, null, null])], ANCHOR_LAT, ANCHOR_LON),
        [], 'a 2D line has no ramp');
});

// ── The predicates ─────────────────────────────────────────────────────────

test('unknown levels classify as nothing', () => {
    for (const [a, b] of [[null, null], [null, 0], [0, null], [undefined, 0], [NaN, 0]]) {
        assert.equal(isPlannerSurfaceLevelSegment(a, b), false, `surface ${a},${b}`);
        assert.equal(isPlannerElevatedSegment(a, b), false, `elevated ${a},${b}`);
        assert.equal(isPlannerUndergroundRampSegment(a, b), false, `ramp ${a},${b}`);
        assert.equal(isPlannerSurfaceOpenCutSegment(a, b), false, `open cut ${a},${b}`);
    }
});

test('known levels still classify as they always did', () => {
    assert.equal(isPlannerSurfaceLevelSegment(0, 0), true);
    assert.equal(isPlannerSurfaceLevelSegment(0, 0.2), false);
    assert.equal(isPlannerElevatedSegment(0, 6), true);
    assert.equal(isPlannerElevatedSegment(0, 0.2, 0.5), false);
    assert.equal(isPlannerElevatedSegment(0, 0.8, 0.5), true);
    assert.equal(isPlannerUndergroundRampSegment(-4, -8), true);
    assert.equal(isPlannerUndergroundRampSegment(-8, -8), false, 'a level bore is not a ramp');
    assert.equal(isPlannerSurfaceOpenCutSegment(0, 0), true);
    assert.equal(isPlannerSurfaceOpenCutSegment(-4, -8), true);
    assert.equal(isPlannerSurfaceOpenCutSegment(-8, -8), false);
});
