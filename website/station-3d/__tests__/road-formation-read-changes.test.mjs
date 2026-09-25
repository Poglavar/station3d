// Completeness of road formation read change sets: any query whose recorded
// evidence misses the change set between two snapshots must answer the same
// from both. Road receivers rely on this to skip recompiling unchanged owners.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel, roadFormationReadChangesSteps } from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { createGroundReadEvidence, freezeGroundReadEvidence, groundReadEvidenceDependsOn,
    withGroundReadEvidence } from '../core/ground-read-evidence.js';

const anchor = { anchorLat: 43.5, anchorLon: 16.4 };
const latitudeM = DEG_TO_RAD * EARTH_RADIUS_M;
const longitudeM = latitudeM * Math.cos(anchor.anchorLat * DEG_TO_RAD);
const lonLat = (x, z) => [anchor.anchorLon + x / longitudeM, anchor.anchorLat - z / latitudeM];
const line = (id, points) => ({ type: 'Feature', properties: { osm_id: id, highway: 'residential' },
    geometry: { type: 'LineString', coordinates: points.map(p => lonLat(...p)) } });
const strip = (id, [x0, z0], [x1, z1], half = 3) => {
    const dx = x1 - x0, dz = z1 - z0, length = Math.hypot(dx, dz), nx = -dz / length * half, nz = dx / length * half;
    return { type: 'Feature', properties: { osm_id: id, highway_type: 'residential' }, geometry: { type: 'Polygon',
        coordinates: [[[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz], [x0 + nx, z0 + nz]]
            .map(p => lonLat(...p))] } };
};
const baseSceneYAtLocal = (x, z) => x * .1 + z * .05 + Math.sin(x / 9) * .4;
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const snapshot = model => { model.getSurfaceProfiles(); return drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal })); };

function road(model, key, id, from, to) {
    model.setCenterlineTile(key, [line(id, [from, to])]);
    model.setSurfaceTile(key, [strip(id, from, to)]);
}

// Every read a road receiver makes, with answers reduced to plain values.
const ids = profiles => profiles.map(profile => String(profile.osmId)).sort();
const QUERIES = [
    ['sceneYAtLocal', (read, x, z) => read.sceneYAtLocal(x, z)],
    ['sceneYAtLocal own', (read, x, z) => read.sceneYAtLocal(x, z, { osmId: 1 })],
    ['groundSceneYAtLocal', (read, x, z) => read.groundSceneYAtLocal(x, z)],
    ['groundSceneYAtLocal tangent', (read, x, z) => read.groundSceneYAtLocal(x, z, { tangentX: 1, tangentZ: 0 })],
    ['civilGroundSceneYAtLocal', (read, x, z) => read.civilGroundSceneYAtLocal(x, z)],
    ['formationAtLocal surface', (read, x, z) => read.formationAtLocal(x, z, { requireSurface: true })?.roadY ?? null],
    ['surfaceAtLocal', (read, x, z) => read.surfaceAtLocal(x, z)?.osmId ?? null],
    ['surfaceProfilesNear', (read, x, z) => ids(read.surfaceProfilesNear(x, z, 12))],
    ['dressingProfilesNear', (read, x, z) => ids(read.dressingProfilesNear(x, z, 12))],
    ['nearbyCenterlineSegments', (read, x, z) => read.nearbyCenterlineSegments(x, z, 15).map(s => s.join(',')).sort()],
    ['hasDressedSurfaceBoundaryAtLocal', (read, x, z) => read.hasDressedSurfaceBoundaryAtLocal(x, z, { osmIds: [1, 2, 5] })],
    ['getSurfaceProfilesForOsmId', read => ids(read.getSurfaceProfilesForOsmId(2))],
];

function assertComplete(before, after, label) {
    const changes = drain(roadFormationReadChangesSteps(before, after));
    let skipped = 0, dependent = 0;
    for (let index = 0; index < 400; index++) {
        // Deterministic spread over the scene and well beyond it.
        const x = ((index * 37) % 200) - 100 + (index % 7) * .31, z = ((index * 53) % 160) - 80 + (index % 5) * .17;
        for (const [name, query] of QUERIES) {
            const evidence = createGroundReadEvidence();
            const answer = withGroundReadEvidence(evidence, () => query(before, x, z));
            if (groundReadEvidenceDependsOn(freezeGroundReadEvidence(evidence), changes)) { dependent++; continue; }
            skipped++;
            assert.deepEqual(query(after, x, z), answer, `${label}: ${name} at ${x.toFixed(2)},${z.toFixed(2)} changed without evidence`);
        }
    }
    // The property must hold on both sides of the boundary, not vacuously.
    assert.ok(skipped > 100 && dependent > 20, `${label}: ${skipped} skipped, ${dependent} dependent`);
    return changes;
}

test('a crossing road changes only reads that reach it', () => {
    const model = new RoadFormationModel({ ...anchor, baseSceneYAtLocal });
    road(model, 'main', 1, [-60, 0], [60, 0]);
    road(model, 'far', 3, [-60, 70], [60, 70]);
    const before = snapshot(model);
    road(model, 'cross', 2, [0, -40], [0, 40]);
    const changes = assertComplete(before, snapshot(model), 'crossing');
    assert.ok(changes.ids.has('2'));
    assert.equal(changes.ids.has('3'), false, 'the distant road is not a change');
});

test('a grade change on a centreline-only road is a change', () => {
    // Paths following a nearby carriageway read its segment grade directly;
    // no surface profile changes when a graph-only road is re-graded.
    const model = new RoadFormationModel({ ...anchor, baseSceneYAtLocal });
    road(model, 'main', 1, [-60, 0], [60, 0]);
    model.setCenterlineTile('graph', [line(5, [[-60, 14], [60, 14]])]);
    const before = snapshot(model);
    model.setCenterlineTile('graph', [line(5, [[-60, 14], [0, 16], [60, 14]])]);
    const changes = assertComplete(before, snapshot(model), 'graph grade');
    assert.ok(changes.ids.has('5'));
});

test('removing a road and an unchanged republication', () => {
    const model = new RoadFormationModel({ ...anchor, baseSceneYAtLocal });
    road(model, 'main', 1, [-60, 0], [60, 0]);
    road(model, 'cross', 2, [0, -40], [0, 40]);
    const before = snapshot(model);
    model.removeSurfaceTile('cross');
    model.removeCenterlineTile('cross');
    assertComplete(before, snapshot(model), 'removal');
    const same = snapshot(model), again = snapshot(model);
    assert.equal(drain(roadFormationReadChangesSteps(same, again)).empty, true, 'recapturing unchanged geometry is not a change');
});
