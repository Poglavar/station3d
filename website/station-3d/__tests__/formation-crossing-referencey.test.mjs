// A plan crossing — two tracks sharing a plan point at different levels (a
// tunnel track passing under a crossing track, as at Brajdica) — is ambiguous
// to a plan-distance nearest query: both tracks are ~equidistant in plan, so the
// height snaps to whichever chord projects marginally closer, producing the
// cab's one-frame vertical jump. formationAtLocal({ referenceY }) resolves it by
// vertical continuity: pick the alignment whose rail sits nearest the height the
// caller is already at. Headless — rail-formation.js imports no THREE.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RailFormationModel } from '../core/rail-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 45.33;
const ANCHOR_LON = 14.44;   // Rijeka-ish; anchor only sets the local frame
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}
function track(points, properties = {}) {
    return {
        type: 'Feature',
        properties: { source: 'cb-proposal', proposalId: '9', ...properties },
        geometry: { type: 'LineString', coordinates: points.map(([x, z]) => lonLat(x, z)) },
    };
}

// Two parallel tracks 3 m apart in plan, held at different rail heights by a
// terrain that rises with z (the level's own designed profile is flat because
// each centreline sees constant terrain). A query BETWEEN them sees both within
// the plan radius — the crossing's ambiguity in miniature.
function twoLevelModel() {
    return new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [
            track([[-500, 0], [500, 0]], { proposalId: 'low' }),   // rail height ~0
            track([[-500, 3], [500, 3]], { proposalId: 'high' }),  // rail height ~15
        ],
        baseSceneYAtLocal: (x, z) => z * 5,
        halfWidthForFeature: () => 2,
    });
}

test('the two levels really do differ in rail height at the shared plan point', () => {
    const model = twoLevelModel();
    const low = model.formationAtLocal(0, 0, { referenceY: 0 });
    const high = model.formationAtLocal(0, 3, { referenceY: 15 });
    assert.ok(low && high, 'both levels resolve');
    assert.ok(high.railY - low.railY > 10,
        `levels should be ~15 m apart, got ${low.railY} vs ${high.railY}`);
});

test('referenceY keeps the query on the level it is already riding', () => {
    const model = twoLevelModel();
    // Midway (1.5 m from each): plan distance cannot separate them.
    const onLow = model.formationAtLocal(0, 1.5, { referenceY: 0 });
    const onHigh = model.formationAtLocal(0, 1.5, { referenceY: 15 });
    assert.ok(Math.abs(onLow.railY - 0) < 1, `riding low, got railY ${onLow.railY}`);
    assert.ok(Math.abs(onHigh.railY - 15) < 1, `riding high, got railY ${onHigh.railY}`);
    // The two queries are the SAME plan point — only referenceY differs, and it
    // flips the resolved level. That is the fix: without it this point is a
    // coin-flip and a moving cab sees the flip as a vertical jump.
    assert.ok(onHigh.railY - onLow.railY > 10, 'referenceY selects the level');
});

test('without referenceY the metric is unchanged (plan-nearest)', () => {
    const model = twoLevelModel();
    // Clearly nearer the low track in plan → low, regardless of any height.
    const near = model.formationAtLocal(0, 0.2);
    assert.ok(Math.abs(near.railY - 0) < 1,
        `plan-nearest should pick the low track, got ${near.railY}`);
});

// A single graded track: the referenceY gate must exclude NOTHING here — the
// ridden rail is always within the gate of the height being ridden — so a query
// with referenceY resolves byte-for-byte the same station and height as a plain
// plan-nearest query. This is the regression guard: making referenceY the
// primary metric instead of a gate reintroduced a per-sample-step wobble in the
// cab's height and grade-chord centre (stationM) on ordinary track.
function gradedSingleTrackModel() {
    return new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track([[-500, 0], [500, 0]])],
        baseSceneYAtLocal: (x) => x * 0.03,   // ~3% grade along the track
        halfWidthForFeature: () => 2,
    });
}

test('referenceY does not perturb selection on a single graded track', () => {
    const model = gradedSingleTrackModel();
    for (let x = -120; x <= 120; x += 15) {
        const plain = model.formationAtLocal(x, 0);
        assert.ok(plain, `plain query resolves at x=${x}`);
        // referenceY lagged slightly below the true rail, as the cab's EMA is.
        const withRef = model.formationAtLocal(x, 0, { referenceY: plain.railY - 0.1 });
        assert.equal(withRef.railY, plain.railY, `railY drifted at x=${x}`);
        assert.equal(withRef.stationM, plain.stationM, `stationM (grade centre) drifted at x=${x}`);
    }
});

test('the gate fails open: a stale referenceY never loses the track', () => {
    const model = gradedSingleTrackModel();
    const plain = model.formationAtLocal(30, 0);
    // referenceY absurdly wrong (a seek to a different elevation): every candidate
    // is gated out, but fail-open returns the plan-nearest so the cab recovers
    // rather than dropping to the terrain fallback.
    const stale = model.formationAtLocal(30, 0, { referenceY: 1000 });
    assert.ok(stale, 'fail-open returns a formation despite the stale referenceY');
    assert.equal(stale.railY, plain.railY, 'fail-open returns the plan-nearest rail');
});
