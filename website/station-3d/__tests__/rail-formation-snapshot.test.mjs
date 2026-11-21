import test from 'node:test';
import assert from 'node:assert/strict';
import { RailFormationModel } from '../core/rail-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const lat = 43.52, lon = 16.4, latScale = DEG_TO_RAD * EARTH_RADIUS_M;
const lonScale = latScale * Math.cos(lat * DEG_TO_RAD);
const track = (z, structure = null) => ({ type: 'Feature',
    properties: { source: 'cb-proposal', proposalId: `${z}`, ...(structure ? { railStructure: structure } : {}) },
    geometry: { type: 'LineString', coordinates: [[lon, lat - z / latScale], [lon + 200 / lonScale, lat - z / latScale]] } });
const drain = iterator => { for (;;) { const step = iterator.next(); if (step.done) return step.value; } };
function fixture() {
    let ground = 10;
    const features = [track(0), track(1000, 'viaduct'), track(2000, 'tunnel')];
    const model = new RailFormationModel({ anchorLat: lat, anchorLon: lon, features,
        baseSceneYAtLocal: (x, z) => ground + x * .002 + z * .001, halfWidthForFeature: () => 4 });
    return { model, features, ground: value => { ground = value; },
        captured: (x, z) => 10 + x * .002 + z * .001 };
}

test('rail read queries match completed geometry and preserve captured upstream ground', () => {
    const f = fixture();
    const snapshot = drain(f.model.captureReadSnapshotSteps({ baseSceneYAtLocal: f.captured }));
    for (const z of [-10, -3, 0, 3, 10, 1000, 2000]) for (const x of [0, 11.5, 87, 195]) {
        for (const name of ['sceneYAtLocal', 'civilGroundSceneYAtLocal', 'coverAtLocal', 'isOpenCutAtLocal']) {
            assert.equal(snapshot[name](x, z), f.model[name](x, z), `${name} at ${x},${z}`);
        }
        assert.deepEqual(snapshot.tunnelRoofInfoAt(x, z), f.model.tunnelRoofInfoAt(x, z));
        assert.equal(snapshot.gradeAlongHeadingAtLocal(x, z, 90), f.model.gradeAlongHeadingAtLocal(x, z, 90));
    }
    assert.equal(snapshot.formationAtFeatureStation(f.features[0], 80).railY,
        f.model.formationAtFeatureStation(f.features[0], 80).railY);
    assert.equal(snapshot.getTunnelRuns()[0].alignment, snapshot.alignments[2]);
    assert.equal(snapshot.getViaductRuns()[0].alignment, snapshot.alignments[1]);
    assert.equal(snapshot.getSurfaceProfiles()[0].alignment, snapshot.alignments[0]);
    assert.deepEqual(snapshot.getSurfaceProfilesAtLocal(50, 0), [snapshot.getSurfaceProfiles()[0]]);
    assert.deepEqual(snapshot.getSurfaceProfilesAtLocal(50, 500), []);
    f.ground(50);
    assert.equal(snapshot.sceneYAtLocal(500, 500), f.captured(500, 500));
    assert.notEqual(snapshot.sceneYAtLocal(500, 500), f.model.sceneYAtLocal(500, 500));
    assert.equal(snapshot._preparations, undefined);
    assert.equal(snapshot._assemblyReuse, undefined);
    assert.equal(snapshot.stepPendingBuild, undefined);
});

test('rail query snapshots retain current flags without sharing mutable crossing state', () => {
    const f = fixture(), original = f.model.profiles[0];
    original.internalSegments[0] = true;
    original.collarInternalSegments[0] = true;
    original.sharedRetainingWallSegments = original.points.map(() => true);
    original.roadOpeningSegmentRanges = original.points.map(() => [[.1, .4]]);
    f.model.civilGroundMutationRevision = 3;
    const snapshot = drain(f.model.captureReadSnapshotSteps({ baseSceneYAtLocal: f.captured }));
    const profile = snapshot.getSurfaceProfiles()[0];
    assert.equal(profile.points, original.points, 'compiled geometry is reused');
    assert.notEqual(profile, original);
    assert.notEqual(profile.internalSegments, original.internalSegments);
    assert.notEqual(profile.roadOpeningSegmentRanges[0][0], original.roadOpeningSegmentRanges[0][0]);
    assert.equal(profile.internalSegments[0], true, 'capture preserves current flags rather than resetting them');
    original.internalSegments[0] = false;
    original.collarInternalSegments[0] = false;
    original.sharedRetainingWallSegments[0] = false;
    original.roadOpeningSegmentRanges[0][0][0] = .2;
    f.model.civilGroundMutationRevision++;
    assert.equal(snapshot.civilGroundMutationRevision, 3);
    assert.equal(profile.internalSegments[0], true);
    assert.equal(profile.collarInternalSegments[0], true);
    assert.equal(profile.sharedRetainingWallSegments[0], true);
    assert.equal(profile.roadOpeningSegmentRanges[0][0][0], .1);
    assert.throws(() => { profile.internalSegments[0] = false; }, TypeError);
    assert.throws(() => { profile.railContextApron = true; }, TypeError);
    assert.equal(snapshot.surfaceProfileAtLocal(50, 0), profile);
    snapshot.civilGroundSceneYAtLocal(50, 0);
    assert.equal(Object.hasOwn(profile, '_innerRingQueryIndex'), false);
    assert.equal(Object.hasOwn(profile, '_terrainCutoutRingQueryIndex'), false);
});

test('rail capture rejects a changing generation and a missing captured ground callback', () => {
    const f = fixture();
    assert.throws(() => drain(f.model.captureReadSnapshotSteps()), /captured upstream/);
    const iterator = f.model.captureReadSnapshotSteps({ baseSceneYAtLocal: f.captured });
    assert.equal(iterator.next().done, false);
    f.model.civilGroundMutationRevision = 1;
    assert.throws(() => drain(iterator), { code: 'rail-formation-snapshot-stale' });
    const pending = new RailFormationModel({ anchorLat: lat, anchorLon: lon, features: f.features,
        baseSceneYAtLocal: f.captured, deferredBuild: true });
    assert.throws(() => drain(pending.captureReadSnapshotSteps({ baseSceneYAtLocal: f.captured })), /complete rail formation/);
});
