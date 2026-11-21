// Verifies the immutable WGS84 photo alignment and its one-point terrain tie.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPhotoTrackFrame,
    resolvePhotoHandoffState,
    resolvePhotoVehiclePose,
    terrainSeatOffset,
    registrationStationsAlong,
    selectConsensusSeatOffset,
} from '../core/photo-track-frame.js';

const ANCHOR = { anchorLon: 16.44, anchorLat: 43.52, heightOriginM: 42 };

test('photo frame origin is the authored session datum', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const point = frame.toScene(ANCHOR.anchorLon, ANCHOR.anchorLat, 0);
    assert.ok(Math.abs(point.x) < 1e-7);
    assert.ok(Math.abs(point.y) < 1e-7);
    assert.ok(Math.abs(point.z) < 1e-7);
});

test('constant-ASL alignment includes tangent-frame curvature instead of inventing terrain drape', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const metresPerDegreeLon = 111320 * Math.cos(ANCHOR.anchorLat * Math.PI / 180);
    const point = frame.toScene(ANCHOR.anchorLon + 10000 / metresPerDegreeLon, ANCHOR.anchorLat, 0);
    assert.ok(Math.abs(point.x - 10000) < 35, `east=${point.x}`);
    assert.ok(point.y < -7.4 && point.y > -8.3, `up=${point.y}`);
});

test('scene round-trip preserves longitude, latitude, and authored height', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const scene = frame.toScene(16.31, 43.55, 18.75);
    const restored = frame.fromScene(scene.x, scene.y, scene.z);
    assert.ok(Math.abs(restored.lon - 16.31) < 1e-8);
    assert.ok(Math.abs(restored.lat - 43.55) < 1e-8);
    assert.ok(Math.abs(restored.relativeHeightM - 18.75) < 1e-4);
});

test('one terrain translation preserves the authored start cut or fill', () => {
    const shift = terrainSeatOffset({
        trackY: 12,
        unshiftedGroundY: 57,
        authoredGroundOffsetM: 3.5,
    });
    assert.equal(shift, -48.5);
    assert.equal(12 - (57 + shift), 3.5);
});

test('changing terrain away from the tie cannot bend the authored profile', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const route = [
        frame.toScene(16.44, 43.52, 0),
        frame.toScene(16.46, 43.52, 8),
        frame.toScene(16.48, 43.52, 16),
    ];
    const before = route.map(point => point.y);
    const googleTerrainRevisionA = [45, 61, 42];
    const googleTerrainRevisionB = [45, 33, 78];
    assert.notDeepEqual(googleTerrainRevisionA, googleTerrainRevisionB);
    assert.deepEqual(route.map(point => point.y), before);
    assert.ok(Math.abs((route[2].y - route[0].y) - (before[2] - before[0])) < 1e-12);
});

test('cab-to-walk handoff keeps the exact frame, seat, and curved scene height', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const metresPerDegreeLon = 111320 * Math.cos(ANCHOR.anchorLat * Math.PI / 180);
    const lon = ANCHOR.anchorLon + 10000 / metresPerDegreeLon;
    const handoff = resolvePhotoHandoffState({
        frame,
        registration: { photoTrackFrame: frame, seatOffsetY: -44.25 },
        lon,
        lat: ANCHOR.anchorLat,
        relativeHeightM: 0,
    });
    assert.equal(handoff.photoTrackFrame, frame);
    assert.equal(handoff.photoSeatOffsetY, -44.25);
    assert.ok(handoff.groundY < -7.4 && handoff.groundY > -8.3, `groundY=${handoff.groundY}`);
});

test('handoff never reuses a seat resolved in another tangent frame', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const other = createPhotoTrackFrame({ ...ANCHOR, anchorLon: 16.5 });
    const handoff = resolvePhotoHandoffState({
        frame,
        registration: { photoTrackFrame: other, seatOffsetY: -40 },
        lon: ANCHOR.anchorLon,
        lat: ANCHOR.anchorLat,
    });
    assert.equal(handoff.photoSeatOffsetY, null);
});

test('frame pitch includes globe curvature but retains the authored grade', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const flat = frame.pitchDegAt({
        lon: ANCHOR.anchorLon + 10000 / (111320 * Math.cos(ANCHOR.anchorLat * Math.PI / 180)),
        lat: ANCHOR.anchorLat,
        headingDeg: 90,
        profilePitchDeg: 0,
    });
    const climbing = frame.pitchDegAt({
        lon: ANCHOR.anchorLon,
        lat: ANCHOR.anchorLat,
        headingDeg: 90,
        profilePitchDeg: 4,
    });
    assert.ok(flat < -0.05 && flat > -0.15, `flat tangent pitch=${flat}`);
    assert.ok(Math.abs(climbing - 4) < 0.02, `climbing pitch=${climbing}`);
});

test('frame orientation follows the actual scene chord, not raw map heading', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const lon = 16.56;
    const lat = 43.58;
    const orientation = frame.orientationAt({
        lon,
        lat,
        relativeHeightM: 12,
        headingDeg: 35,
        profilePitchDeg: 2,
        stepM: 8,
    });
    assert.ok(Number.isFinite(orientation.headingDeg));
    assert.ok(Math.abs(orientation.pitchDeg - 2) < 0.2);
    assert.ok(Math.abs(orientation.headingDeg - 35) > 0.001, 'far-field scene yaw includes frame convergence');
});

test('an articulated car uses the same photo-frame position and orientation as its rails', () => {
    const frame = createPhotoTrackFrame(ANCHOR);
    const car = resolvePhotoVehiclePose(frame, {
        lon: 16.56,
        lat: 43.58,
        headingDeg: 35,
    }, {
        relativeHeightM: 12,
        profilePitchDeg: 2,
    });
    const railPoint = frame.toScene(16.56, 43.58, 12);
    const railOrientation = frame.orientationAt({
        lon: 16.56,
        lat: 43.58,
        relativeHeightM: 12,
        headingDeg: 35,
        profilePitchDeg: 2,
    });

    assert.deepEqual(
        { x: car.x, y: car.y, z: car.z },
        { x: railPoint.x, y: railPoint.y, z: railPoint.z },
    );
    assert.equal(car.headingDeg, railOrientation.headingDeg);
    assert.equal(car.pitchDeg, railOrientation.pitchDeg);
    assert.notEqual(car.headingDeg, 35, 'raw compass yaw is not reused in the fixed tangent frame');
});

test('consensus seat offset is the median and outvotes clutter at one station', () => {
    // Six honest stations agree near -42; the km-0 station reads a platform
    // roof and proposes -49. The single-point registration would have floated
    // the whole route 7 m; the consensus barely moves.
    assert.equal(selectConsensusSeatOffset([-49.1, -42.0, -42.2, -41.9, -42.1, -42.3, -41.8]), -42.1);
    assert.equal(selectConsensusSeatOffset([-42.0, -41.0]), null, 'below the candidate minimum');
    assert.equal(selectConsensusSeatOffset([-42.0, -41.0], { minCandidates: 2 }), -41.5,
        'even count averages the middle pair');
    assert.equal(selectConsensusSeatOffset([NaN, null, undefined]), null);
});

test('registration stations spread along the alignment around the reference', () => {
    // One straight 1 km segment along +x at track height 10..20.
    const segs = [0, 0, 1000, 0, 10, 20];
    const stations = registrationStationsAlong(segs, 100, 5, {
        spacingM: 80,
        maxStations: 5,
        maxSpanM: 700,
        segmentTrackIds: ['t1'],
    });
    assert.equal(stations.length, 5);
    assert.equal(stations[0].arcM, 100, 'first station sits at the nearest arc position');
    const arcs = stations.map((s) => s.arcM).sort((a, b) => a - b);
    assert.deepEqual(arcs, [20, 100, 180, 260, 340].sort((a, b) => a - b));
    for (const station of stations) {
        assert.equal(station.z, 0);
        assert.equal(station.trackId, 't1');
        assert.ok(Math.abs(station.y - (10 + 10 * station.arcM / 1000)) < 1e-9,
            'track height lerps along the segment');
        assert.equal(station.ux, 1);
        assert.equal(station.uz, 0);
    }
});

test('registration stations clamp to the route and skip degenerate segments', () => {
    const segs = [
        0, 0, 0, 0, 5, 5,      // zero-length: skipped
        0, 0, 120, 0, 0, 1.2,
    ];
    const stations = registrationStationsAlong(segs, -50, 0, {
        spacingM: 80,
        maxStations: 7,
        maxSpanM: 700,
    });
    // Reference projects onto the start; only forward stations exist and the
    // route is only 120 m long.
    const arcs = stations.map((s) => s.arcM).sort((a, b) => a - b);
    assert.deepEqual(arcs, [0, 80]);
});
