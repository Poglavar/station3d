// Where a train sits ACROSS the track at a station.
//
// The two running track centres splay apart around a rigid underground ISLAND
// hall, and a train stopping there has to splay with them. Nothing else splays:
// not a surface platform, not an elevated one, and not a route-following covered
// station (which keeps ordinary spacing and a side platform). Getting that wrong
// is worth 4.9 m of lateral error — the island spacing is 13.2 m against a 3.4 m
// running spacing — which is enough to park a train on the grass beside its own
// platform, and did.
//
// The point of these tests is that there is now ONE policy — the same function,
// reading the same station list, for the rails and for anything riding them.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ridingTrackCenterOffsetM,
    stationFlaresThatSplayTrackCenters,
} from '../core/planner-station-flare.js';
import {
    getTrackCenterSpacingMeters,
    getTrackCenterSpacingAtStationDistanceMeters,
} from '../world/tram-trackbed-dimensions.js';

const TRACK = { trackType: 'g1435', trackCount: 2, trackIds: [1] };
const SINGLE_TRACK = { trackType: 'g1435', trackCount: 1, trackIds: [1] };
const RUNNING_SPACING_M = getTrackCenterSpacingMeters(TRACK);
const RUNNING_OFFSET_M = RUNNING_SPACING_M * 0.5;

// THE function ambient-trains.js calls — not a re-implementation of it. If the
// train's offset stops going through here, or this stops consulting the rails'
// own flare list, these tests fail.
function trainOffsetM(publishedFlares, x, z = 0, properties = TRACK) {
    return ridingTrackCenterOffsetM(properties, x, z, publishedFlares);
}

// What rails.js publishes: its flare profiles, minus the ones that do not splay.
function published(stationFlares) {
    return stationFlaresThatSplayTrackCenters(stationFlares)
        .map(station => ({ x: station.x, z: station.z, trackId: station.trackId }));
}

const islandHall = (x, trackId = 1) => ({ x, z: 0, trackId, coveredRoute: null });
const coveredRoute = (x, trackId = 1) => ({
    x, z: 0, trackId, coveredRoute: { route: {}, startM: 0, endM: 100 },
});

test('the island flare is a real splay, not a rounding difference', () => {
    // If these two were close together the bug would have been invisible; every
    // test below is only meaningful because the gap is metres wide.
    const islandSpacingM = getTrackCenterSpacingAtStationDistanceMeters(TRACK, 0, null);
    assert.ok(islandSpacingM > RUNNING_SPACING_M + 5, `${islandSpacingM} vs ${RUNNING_SPACING_M}`);
    assert.ok((islandSpacingM - RUNNING_SPACING_M) / 2 > 4, 'over 4 m of lateral error at stake');
});

test('a train rides the running centre where no station splays the rails', () => {
    // A surface or elevated platform never enters the flare list at all —
    // rails.js only builds profiles for underground stops.
    for (const x of [0, 100, 500]) {
        assert.equal(trainOffsetM([], x), RUNNING_OFFSET_M, `at x=${x} with no flares`);
    }
});

test('a train splays out with its rails at an island hall', () => {
    const flares = published([islandHall(0)]);
    assert.ok(trainOffsetM(flares, 0) > RUNNING_OFFSET_M + 4, 'inside the island envelope');
    assert.equal(trainOffsetM(flares, 400), RUNNING_OFFSET_M, 'back to running spacing between stations');
});

test('a route-following covered station does NOT splay, so neither does the train', () => {
    // The gap this change closes. Such a station keeps the ordinary spacing and
    // a side platform, so a train taking the island offset there stood 4.9 m off
    // its own rails — the same failure as at a surface platform, one level down.
    const flares = published([coveredRoute(0)]);
    assert.deepEqual(flares, [], 'it is not published as a splaying station');
    assert.equal(trainOffsetM(flares, 0), RUNNING_OFFSET_M);
});

test('rails and train cannot disagree, because they read the same list', () => {
    // One island hall and one covered station on the same route: the train
    // splays where the rails did and nowhere else.
    const flares = published([islandHall(0), coveredRoute(600)]);
    assert.ok(trainOffsetM(flares, 0) > RUNNING_OFFSET_M + 4, 'island splays');
    assert.equal(trainOffsetM(flares, 600), RUNNING_OFFSET_M, 'covered does not');
    assert.equal(trainOffsetM(flares, 300), RUNNING_OFFSET_M, 'nor between them');
});

test('a single-track route has ONE centre, on the axis', () => {
    // Spacing is not the offset. Halving a single track's nominal spacing would
    // shove every train on it 1.7 m into the grass — including away from any
    // station, where nothing is supposed to be happening at all.
    assert.equal(trainOffsetM([], 0, 0, SINGLE_TRACK), 0, 'plain running line');
    assert.equal(
        trainOffsetM(published([islandHall(0)]), 0, 0, SINGLE_TRACK), 0,
        'and inside an island envelope: one track cannot splay from itself',
    );
});

test('a station on another track does not splay this train', () => {
    // A crossing line's island hall must never widen the track a train is on.
    const flares = published([islandHall(0, 99)]);
    assert.equal(trainOffsetM(flares, 0), RUNNING_OFFSET_M);
});

test('no rails built yet means running spacing, not a guess', () => {
    // getStationTrackSpacingFlares() is empty before the first rails build. The
    // safe answer is the unsplayed one: a train slightly inboard at a station is
    // survivable, a train in a field is not.
    assert.equal(trainOffsetM(undefined, 0), RUNNING_OFFSET_M);
    assert.equal(trainOffsetM(null, 0), RUNNING_OFFSET_M);
});

test('stationFlaresThatSplayTrackCenters drops only the non-splaying ones', () => {
    const kept = stationFlaresThatSplayTrackCenters([
        islandHall(0), coveredRoute(10), islandHall(20), null, undefined,
    ]);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map(station => station.x), [0, 20]);
    assert.deepEqual(stationFlaresThatSplayTrackCenters(null), []);
});
