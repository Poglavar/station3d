// The station's contract with everything around it. The invariant that matters
// most is the first one: a tunnel meets the station at its normal section and
// never has to know a station is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyStationVerticalForm,
    COMPACT_COVERED_STATION,
    describeStation,
    isInsideStation,
    STATION_VERTICAL_FORM,
    stationTypeIds,
} from '../core/station-contract.js';
import {
    getTrackCenterSpacingMeters,
    getTrackCenterSpacingAtStationDistanceMeters,
} from '../world/tram-trackbed-dimensions.js';
import {
    UNDERGROUND_STATION_HALL_HALF_WIDTH_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
} from '../world/planner-station-layout.js';

const RUNNING_SPACING_M = 3.4;   // g1435, from tram-trackbed-dimensions.js
const island = () => describeStation('underground-island', {
    runningTrackSpacingM: RUNNING_SPACING_M,
});

test('station depth transitions full to compact covered to open cut', () => {
    const classify = (depthM) => classifyStationVerticalForm({
        railElevAslM: 100,
        terrainSamplesAslM: [100 + depthM],
    });
    assert.equal(classify(10.3).form, STATION_VERTICAL_FORM.FULL);
    assert.equal(classify(10.28).form, STATION_VERTICAL_FORM.COMPACT_COVERED);
    assert.equal(classify(8.95).form, STATION_VERTICAL_FORM.COMPACT_COVERED);
    assert.equal(classify(8.93).form, STATION_VERTICAL_FORM.OPEN_CUT);
    assert.equal(classify(9.5).selected.lengthM, COMPACT_COVERED_STATION.lengthM);
    assert.equal(
        classify(9.5).selected.heightAboveRailM,
        COMPACT_COVERED_STATION.heightAboveRailM,
    );
});

test('a tunnel meets the station unchanged at every port', () => {
    // The whole point: tunnels stay tunnels. Whatever the station does inside
    // its envelope, at the port the track is back to running spacing, so the
    // tunnel builder needs no knowledge of stations at all.
    const s = island();
    assert.equal(s.ports.length, 2);
    for (const port of s.ports) {
        assert.equal(port.trackSpacingM, RUNNING_SPACING_M);
        assert.ok(Math.abs(s.trackSpacingAtM(port.alongM) - RUNNING_SPACING_M) < 1e-9,
            `spacing at port ${port.alongM} m is ${s.trackSpacingAtM(port.alongM)}`);
    }
    // Ports sit at the two ends of the envelope, symmetrically.
    assert.deepEqual(s.ports.map((p) => p.alongM), [-s.envelope.halfLengthM, s.envelope.halfLengthM]);
});

test('the widening happens INSIDE the station, not along the tunnel', () => {
    const s = island();
    // Island spacing at the platform...
    assert.ok(Math.abs(s.trackSpacingAtM(0) - 13.2) < 1e-9);
    // ...and nothing beyond the ports is touched.
    for (const alongM of [-500, -s.envelope.halfLengthM - 0.01, s.envelope.halfLengthM + 0.01, 500]) {
        assert.equal(s.trackSpacingAtM(alongM), RUNNING_SPACING_M,
            `station reached ${alongM} m, outside its own envelope`);
    }
});

test('the flare is monotonic from platform to port', () => {
    // A non-monotonic transition would kink the track inside the throat.
    const s = island();
    let previous = s.trackSpacingAtM(0);
    for (let alongM = 0; alongM <= s.envelope.halfLengthM; alongM += 1) {
        const spacing = s.trackSpacingAtM(alongM);
        assert.ok(spacing <= previous + 1e-9, `spacing widened again at ${alongM} m`);
        previous = spacing;
    }
    // Symmetric either way down the route.
    for (const alongM of [5, 25, 45, 65, 85]) {
        assert.ok(Math.abs(s.trackSpacingAtM(alongM) - s.trackSpacingAtM(-alongM)) < 1e-12);
    }
});

test('the platform keeps full island spacing for its whole length', () => {
    // Trains stop along the platform; the spacing must not be tapering there.
    const s = island();
    const platformHalf = s.envelope.platformLengthM * 0.5;
    for (const alongM of [-platformHalf, -15, 0, 15, platformHalf]) {
        assert.ok(Math.abs(s.trackSpacingAtM(alongM) - 13.2) < 1e-9,
            `spacing already tapering at ${alongM} m`);
    }
});

test('occupancy is published, not inferred from the tunnel', () => {
    // The Vidi bug: walk physics measured against the running tunnel's 3.9 m
    // half width while the platform spawn stands 6.6 m out, so it found no floor
    // at the one point a walker is always placed and lifted them to the street.
    // Asking the station instead cannot produce that mismatch.
    const s = island();
    const spawnOffsetM = 13.2 / 2;   // between the rails of one track
    assert.ok(s.occupancy.halfWidthM >= spawnOffsetM,
        `interior ${s.occupancy.halfWidthM} m cannot contain a spawn ${spawnOffsetM} m out`);
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: spawnOffsetM, heightM: 0.1 }), true);
    // A tunnel-width assumption would have said no.
    assert.ok(spawnOffsetM > 3.9, 'guard: the spawn really is outside the tunnel section');
});

test('inside/outside is decided in three dimensions', () => {
    const s = island();
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: 0, heightM: 0 }), true, 'on the floor');
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: 0, heightM: 9.6 }), true, 'at the ceiling');
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: 0, heightM: 12 }), false, 'above the roof');
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: 0, heightM: -1 }), false, 'below the floor');
    assert.equal(isInsideStation(s, { alongM: 200, offsetM: 0, heightM: 0 }), false, 'past the port');
    assert.equal(isInsideStation(s, { alongM: 0, offsetM: 20, heightM: 0 }), false, 'through the wall');
    assert.equal(isInsideStation(null, { alongM: 0, offsetM: 0 }), false);
    assert.equal(isInsideStation(s, { alongM: NaN, offsetM: 0 }), false);
});

test('requirements are stated for the planner to validate', () => {
    // The station says what it needs; nobody reshapes it to fit. The depth
    // requirement is what the 8 m tunnel rule does not cover — a 9.6 m box needs
    // 10.3 m or its roof comes up through the road.
    const s = island();
    assert.equal(s.requirements.straightLengthM, 170);
    assert.equal(s.requirements.levelLengthM, 170);
    assert.ok(Math.abs(s.requirements.minDepthBelowGroundM - 10.3) < 1e-9);
    assert.ok(s.requirements.minDepthBelowGroundM > 8,
        'guard: the tunnel rule alone is not enough for a station');
});

test('the description reproduces today geometry exactly', () => {
    // Migration safety: consumers moved onto the contract must see the same
    // numbers they read from the shared constants today, or the switch is not
    // behaviour-neutral and a visual regression is hiding in it.
    const s = island();
    assert.equal(s.envelope.platformLengthM, 60);
    assert.equal(s.envelope.lengthM, 170);
    assert.equal(s.envelope.halfLengthM, 85);
    assert.equal(s.envelope.halfWidthM, 10.5);
    assert.equal(s.envelope.heightAboveRailM, 9.6);
    assert.equal(s.occupancy.platformTopAboveRailM, 0.55);
});

test('narrower running spacing still meets its own ports', () => {
    // g1000 runs at 2.8 m. The contract is per-instance, so a tram station and a
    // metro station each meet their own tunnel.
    const tram = describeStation('underground-island', { runningTrackSpacingM: 2.8 });
    assert.equal(tram.trackSpacingAtM(tram.ports[0].alongM), 2.8);
    assert.ok(Math.abs(tram.trackSpacingAtM(0) - 13.2) < 1e-9, 'island width is the station\'s own');
});

test('unknown types and nonsense inputs describe nothing', () => {
    assert.equal(describeStation('no-such-type', { runningTrackSpacingM: 3.4 }), null);
    assert.equal(describeStation('underground-island', { runningTrackSpacingM: 0 }), null);
    assert.equal(describeStation('underground-island', {}), null);
    assert.ok(stationTypeIds().includes('underground-island'));
});

// Golden values, computed from the smoothstep flare as it stood BEFORE the
// renderer delegated to the contract. They are the only thing left that can
// catch a change to the curve now that live and contract are the same code —
// a test comparing the two would pass no matter what either one did.
const GOLDEN_SPACING_M = [
    [0, 13.2], [15, 13.2], [30, 13.2],
    [42.5, 11.911495], [55, 8.966341], [70, 5.189181],
    [84.9, 3.400097], [85, 3.4], [100, 3.4],
];

test('the flare still follows the curve the renderer drew before the migration', () => {
    const props = { trackType: 'g1435', trackCount: 2 };
    const s = describeStation('underground-island', {
        runningTrackSpacingM: getTrackCenterSpacingMeters(props),
    });
    for (const [alongM, expected] of GOLDEN_SPACING_M) {
        assert.ok(Math.abs(s.trackSpacingAtM(alongM) - expected) < 1e-6,
            `contract at ${alongM} m: ${s.trackSpacingAtM(alongM)}, was ${expected}`);
        // ...and the live entry point agrees, with depth easing left off.
        const live = getTrackCenterSpacingAtStationDistanceMeters(props, alongM, null);
        assert.ok(Math.abs(live - expected) < 1e-6,
            `live at ${alongM} m: ${live}, was ${expected}`);
    }
});

test('an unknown distance from a station never flares the track', () => {
    // The delegation turned "how far from the station?" into "where along the
    // station?", and Number(NaN) || 0 would have answered "at the platform" —
    // full island spacing for track that may be nowhere near a station.
    const props = { trackType: 'g1435', trackCount: 2 };
    const running = getTrackCenterSpacingMeters(props);
    const s = describeStation('underground-island', { runningTrackSpacingM: running });
    for (const bad of [NaN, undefined, null, Infinity, 'nonsense']) {
        assert.equal(s.trackSpacingAtM(bad), running, `flared on ${String(bad)}`);
        assert.equal(getTrackCenterSpacingAtStationDistanceMeters(props, bad, null), running);
    }
});

test('depth easing composes on top of the station, and only shrinks the flare', () => {
    // Depth easing lives OUTSIDE the contract on purpose. Whatever it does, it
    // may only interpolate between running spacing and what the station asked
    // for — never widen past it, never fall below the running tunnel.
    const props = { trackType: 'g1435', trackCount: 2 };
    const running = getTrackCenterSpacingMeters(props);
    const s = describeStation('underground-island', { runningTrackSpacingM: running });
    for (const alongM of [0, 30, 55, 84]) {
        const stationSpacing = s.trackSpacingAtM(alongM);
        for (const elevM of [-12, -8, -6, -4, -2, 0, 5]) {
            const live = getTrackCenterSpacingAtStationDistanceMeters(props, alongM, elevM);
            assert.ok(live >= running - 1e-9, `${live} m narrower than the running tunnel`);
            assert.ok(live <= stationSpacing + 1e-9, `${live} m wider than the station asked for`);
        }
        // At and below full-flare depth the station gets exactly what it asked.
        assert.ok(Math.abs(
            getTrackCenterSpacingAtStationDistanceMeters(props, alongM, -8) - stationSpacing,
        ) < 1e-9);
        // Above ground the flare is gone.
        assert.equal(getTrackCenterSpacingAtStationDistanceMeters(props, alongM, 0), running);
    }
});

test('occupancy equals the layout constants the walk physics used to read', () => {
    // planner-elevation.js now asks the station how far it reaches instead of
    // reading these two constants directly. That swap is only behaviour-neutral
    // while the numbers agree, so pin them: if the contract and the layout drift
    // apart, the corridor silently changes width and Vidi lands somewhere new.
    const s = island();
    assert.equal(s.occupancy.halfWidthM, UNDERGROUND_STATION_HALL_HALF_WIDTH_M);
    assert.equal(s.occupancy.halfLengthM, UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5);
});
