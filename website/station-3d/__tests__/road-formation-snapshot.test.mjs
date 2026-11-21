import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel, formationDressingSurfaceYAtLocal } from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const anchorLat = 45.8, anchorLon = 16;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(anchorLat * DEG_TO_RAD);
const ll = ([x, z]) => [anchorLon + x / lonScale, anchorLat - z / latScale];
function fixture(extra = {}) {
    const terrain = (x, z) => x * .08 + z * .1;
    const model = new RoadFormationModel({ anchorLat, anchorLon, baseSceneYAtLocal: terrain, ...extra });
    const line = { properties: { osm_id: 1, highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[-20, 0], [20, 0]].map(ll) } };
    const polygon = { properties: { osm_id: 1, highway_type: 'residential' }, geometry: { type: 'Polygon', coordinates: [[[-20, -3], [20, -3], [20, 3], [-20, 3], [-20, -3]].map(ll)] } };
    model.setCenterlineTile('a', [line]); model.setSurfaceTile('a', [polygon]);
    model.getSurfaceProfiles();
    return { model, terrain, line, polygon };
}
const drain = iterator => { for (;;) { const step = iterator.next(); if (step.done) return step.value; } };
const queries = view => [[0, 0], [-15, 2], [0, 5], [5, 35]].map(([x, z]) => ({
    y: view.sceneYAtLocal(x, z, { osmId: 1 }),
    ground: view.groundSceneYAtLocal(x, z),
    civil: view.civilGroundSceneYAtLocal(x, z),
    nearest: view.formationAtLocal(x, z),
    profiles: view.surfaceProfilesNear(x, z, 10).map(profile => profile.osmId),
}));

test('captured road queries and publication eligibility survive later model revisions', () => {
    const { model, terrain, line, polygon } = fixture();
    const captured = drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal: terrain }));
    const before = structuredClone(queries(captured));
    assert.deepEqual(before, queries(model));
    assert.equal(captured.setSurfaceTile, undefined);
    assert.equal(captured.invalidateTerrain, undefined);
    assert.equal(captured.hasPendingBuild(), false);
    assert.equal(captured.getSurfaceProfilesForFeature(polygon).length, 1);
    model.setSurfacePublicationReadyForOsmIds([1], false);
    assert.equal(model.civilGroundSceneYAtLocal(0, 0), null);
    assert.equal(captured.getSurfaceProfiles()[0].surfacePublicationReady, true);
    model.setCenterlineTile('a', [{ ...line, geometry: { ...line.geometry, coordinates: [[-20, 10], [20, 10]].map(ll) } }]);
    model.getSurfaceProfiles();
    assert.notEqual(model.sceneYAtLocal(0, 0, { osmId: 1 }), before[0].y);
    assert.deepEqual(queries(captured), before);
    assert.equal(captured.getSurfaceGeometryGeneration(1), 1);
    assert.ok(model.getSurfaceGeometryGeneration(1) > 1);
});

test('a snapshot refuses evolving upstream closures unless the caller supplies captured replacements', () => {
    let liveOverride = 2;
    const { model } = fixture({ roadYOverrideAtLocal: () => liveOverride });
    assert.throws(() => drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal: () => 0 })), /captured roadYOverrideAtLocal/);
    const captured = drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal: () => 0, roadYOverrideAtLocal: () => 2 }));
    liveOverride = 9;
    model.baseSceneYAtLocal = () => 20;
    assert.equal(model.sceneYAtLocal(0, 0, { osmId: 1 }), 9);
    assert.equal(captured.sceneYAtLocal(0, 0, { osmId: 1 }), 2);
    assert.equal(captured.groundSceneYAtLocal(0, 35), 0);
});

test('publication or geometry changes during capture reject the partial snapshot', () => {
    for (const revise of [model => model.setSurfacePublicationReadyForOsmIds([1], false),
        model => model.removeSurfaceTile('a')]) {
        const { model, terrain } = fixture();
        const task = model.captureReadSnapshotSteps({ baseSceneYAtLocal: terrain });
        assert.equal(task.next().done, false);
        revise(model);
        assert.throws(() => drain(task), { code: 'formation-snapshot-stale' });
    }
});

test('dressing query caches stay outside read-only profile records', () => {
    const { model } = fixture();
    const profile = model.getSurfaceProfiles()[0];
    const a = profile.points[0], b = profile.points[1];
    const x = (a.innerX + a.outerX + b.innerX + b.outerX) / 4;
    const z = (a.innerZ + a.outerZ + b.innerZ + b.outerZ) / 4;
    Object.freeze(profile);
    const y = formationDressingSurfaceYAtLocal(profile, x, z);
    assert.ok(Number.isFinite(y));
    assert.equal(formationDressingSurfaceYAtLocal(profile, x, z), y);
    assert.equal('_formationDressingQueryIndex' in profile, false);
});
