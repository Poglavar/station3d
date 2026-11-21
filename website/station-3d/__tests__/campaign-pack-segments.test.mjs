// A level bake split into restartable bands: the bands must tile the level's
// chunk cells exactly once, their captures must overlap so nothing is clipped at
// a seam, and each band must carry the stretch of corridor its world waits for.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignPackBakeSegmentPlan,
    campaignPackSegmentDrivePreload,
    campaignPackSegmentOwnsChunkKey,
    campaignPackSegmentPlan,
    parseCampaignPackSegment,
} from '../core/campaign-pack-segments.js';

const BOUNDS = { west: 15.954, south: 45.793, east: 15.995, north: 45.826 };
const ANCHOR = { lat: 45.8035551, lon: 15.9695197 };
const CORRIDOR = [
    { lat: 45.8035551, lon: 15.9695197 },
    { lat: 45.805620, lon: 15.9793955 },
    { lat: 45.812000, lon: 15.970000 },
];

function plan(index, count) {
    return campaignPackSegmentPlan({
        bounds: BOUNDS, packAnchor: ANCHOR, chunkSizeM: 250, index, count, corridorPath: CORRIDOR,
    });
}

test('a segment spec is only accepted when it names a band of a real split', () => {
    assert.deepEqual(parseCampaignPackSegment('2/5'), { index: 2, count: 5 });
    assert.equal(parseCampaignPackSegment('0/3'), null);
    assert.equal(parseCampaignPackSegment('4/3'), null);
    assert.equal(parseCampaignPackSegment(null), null);
});

test('bands tile the level exactly once, so merged chunk keys can never collide', () => {
    const count = 4;
    const plans = Array.from({ length: count }, (_, i) => plan(i + 1, count));
    assert.ok(plans.every(Boolean));
    for (let i = 1; i < count; i++) {
        assert.equal(plans[i].ownedCells.min, plans[i - 1].ownedCells.max + 1);
    }
    assert.ok(plans[0].ownedCells.max > plans[0].ownedCells.min);

    // Every cell of the level belongs to exactly one band.
    const whole = plan(1, 1);
    for (let cell = whole.ownedCells.min; cell <= whole.ownedCells.max; cell++) {
        const key = `ground-x${cell < 0 ? `n${-cell}` : `p${cell}`}-zp0`;
        const owners = plans.filter(entry => campaignPackSegmentOwnsChunkKey(entry, key));
        assert.equal(owners.length, 1, `cell ${cell} has ${owners.length} owners`);
    }
});

test('captures overlap at a seam but ownership does not', () => {
    const first = plan(1, 3);
    const second = plan(2, 3);
    const seamOverlaps = first.captureBounds.east > second.captureBounds.west
        || first.captureBounds.north > second.captureBounds.south;
    assert.ok(seamOverlaps, 'adjacent captures must overlap so nothing is clipped');
    assert.ok(second.ownedCells.min > first.ownedCells.max);
});

test('each band carries the stretch of corridor its world must wait for', () => {
    const count = 3;
    const slices = Array.from({ length: count }, (_, i) => plan(i + 1, count))
        .map(entry => entry.corridorPath)
        .filter(Boolean);
    assert.ok(slices.length >= 2, 'a corridor crossing the level reaches several bands');
    for (const slice of slices) {
        assert.equal(slice.length, 2);
        for (const point of slice) {
            assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lon));
        }
    }
    // A slice is shorter than the whole authored corridor: that is the point.
    const whole = plan(1, 1).corridorPath;
    const span = entry => Math.hypot(entry[1].lat - entry[0].lat, entry[1].lon - entry[0].lon);
    assert.ok(slices.every(slice => span(slice) <= span(whole) + 1e-9));
    assert.ok(slices.some(slice => span(slice) < span(whole)));
});

const AUTHORED_PACK = {
    packId: 'toranj-ljepote-zagreb',
    bakeDriveSurfacePreload: { path: CORRIDOR, halfWidthM: 450, sampleStepM: 75 },
    bake: { anchor: ANCHOR, visualBounds: BOUNDS, chunkSizeM: 250 },
};

test('both bake seams resolve the same band from the authored level', () => {
    const plan = campaignPackBakeSegmentPlan(AUTHORED_PACK, '2/3');
    assert.ok(plan);
    assert.equal(plan.index, 2);
    assert.equal(plan.count, 3);
    const preload = campaignPackSegmentDrivePreload(AUTHORED_PACK, plan);
    assert.equal(preload.halfWidthM, 450, 'the authored corridor width is kept');
    assert.notDeepEqual(preload.path, CORRIDOR, 'the path is cut down to this band');
    assert.ok(preload.path.length >= 2);
});

test('no segment spec means the whole level, exactly as before segments existed', () => {
    assert.equal(campaignPackBakeSegmentPlan(AUTHORED_PACK, null), null);
    assert.equal(campaignPackBakeSegmentPlan(AUTHORED_PACK, '1/1'), null);
    assert.deepEqual(campaignPackSegmentDrivePreload(AUTHORED_PACK, null), AUTHORED_PACK.bakeDriveSurfacePreload);
});

// Keys as a real capture writes them (safeCell: p0, p1, n1 …). The first version
// of this filter read bare integers, matched nothing, and would have failed every
// band with "captured no chunks of its own".
test('ownership is decided on the key format a capture actually produces', () => {
    const plan = campaignPackSegmentPlan({
        bounds: BOUNDS, packAnchor: ANCHOR, chunkSizeM: 250, index: 1, count: 2,
    });
    const cell = value => (value < 0 ? `n${-value}` : `p${value}`);
    const keyAt = (along, across) => (plan.axis === 'x'
        ? `ground-x${cell(along)}-z${cell(across)}`
        : `ground-x${cell(across)}-z${cell(along)}`);

    assert.equal(campaignPackSegmentOwnsChunkKey(plan, keyAt(plan.ownedCells.min, 0)), true);
    assert.equal(campaignPackSegmentOwnsChunkKey(plan, keyAt(plan.ownedCells.max, -3)), true);
    assert.equal(campaignPackSegmentOwnsChunkKey(plan, keyAt(plan.ownedCells.max + 1, 0)), false);
    assert.equal(campaignPackSegmentOwnsChunkKey(plan, keyAt(plan.ownedCells.min - 1, 0)), false);
    assert.equal(campaignPackSegmentOwnsChunkKey(plan, 'ground-x2-z0'), false, 'a key in no known format is not owned');
});
