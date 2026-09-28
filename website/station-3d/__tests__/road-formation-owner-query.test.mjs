import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel } from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { createGroundChangeSet, createGroundReadEvidence, freezeGroundReadEvidence,
    groundReadEvidenceDependsOn, withGroundReadEvidence } from '../core/ground-read-evidence.js';

const metre = DEG_TO_RAD * EARTH_RADIUS_M;
const baseSceneYAtLocal = (x, z) => 10 + x * .02 + z * .03;
const line = (id, points) => ({ type: 'Feature', properties: { osm_id: id, highway: 'residential' },
    geometry: { type: 'LineString', coordinates: points.map(([x, z]) => [x / metre, -z / metre]) } });
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
function model(lines, options = {}) {
    const value = new RoadFormationModel({ anchorLat: 0, anchorLon: 0, baseSceneYAtLocal, ...options });
    value.setCenterlineTile('roads', lines);
    value.getSurfaceProfiles();
    return value;
}
const snapshot = value => drain(value.captureReadSnapshotSteps({ baseSceneYAtLocal }));
function exhaustive(value, x, z, ids) {
    let best = null;
    for (const id of [...new Set(ids.map(String))]) {
        const candidate = value.formationAtLocal(x, z, { osmId: id, allowStale: true });
        if (candidate && (!best || candidate.distanceSquared < best.distanceSquared)) best = candidate;
    }
    return best;
}
function union(count = 128) {
    return Array.from({ length: count }, (_, i) => line(i + 1,
        Array.from({ length: 25 }, (_, k) => [10 + i % 16 * 240 + k * 4, 40 + Math.floor(i / 16) * 240])));
}

test('large curb owner unions inspect local road segments, with the exact exhaustive answer', t => {
    const value = model(union()), ids = Array.from({ length: 128 }, (_, i) => i + 1);
    value.resetSegmentProjectionCount();
    const expected = exhaustive(value, 40, 41, ids);
    const before = value.getSegmentProjectionCount();
    value.resetSegmentProjectionCount();
    const actual = value.formationAtLocal(40, 41, { osmIds: ids });
    const after = value.getSegmentProjectionCount();
    assert.deepEqual(actual, expected);
    t.diagnostic(JSON.stringify({ owners: ids.length, before, after }));
    assert.ok(after < before / 8, `${before} → ${after} segment projections`);
});

test('multi-owner queries match exhaustive queries at cell edges, negative coordinates and distant points', () => {
    const value = model([...union(32), line(50, [[-200, -80], [200, 80]]),
        line(51, [[-160, -40], [-80, -40], [-80, 80]])]);
    const ids = [...Array.from({ length: 32 }, (_, i) => String(32 - i)), 50, 51, 999, '1', 1];
    const read = snapshot(value);
    const points = [[40, 41], [0, 0], [-.001, -.001], [80, 80], [79.999, 80.001], [-80, -80],
        [160, 240], [250, 41], [40000, 40000], [-40000, -40000]];
    for (let i = 0; i < 120; i++) points.push([i * 139 % 1500 - 300, i * 97 % 700 - 200]);
    for (const [x, z] of points) {
        const expected = exhaustive(value, x, z, ids);
        for (const query of [value, read]) {
            assert.deepEqual(query.formationAtLocal(x, z, { osmIds: ids, maxDistanceM: .01 }), expected,
                `exact unbounded owner query at ${x},${z}`);
        }
    }
    read.release();
});

test('ties keep requested-owner order and the existing per-owner projection, including raised roads', () => {
    const value = model([line(1, [[-30, -4], [0, -4], [30, -4]]),
        line(2, [[-30, 4], [0, 4], [30, 4]])], {
        roadYOverrideAtLocal: (x, z, id) => id === '2' ? 100 : null,
    });
    for (const ordered of [[1, 2], [2, 1]]) {
        const ids = [...ordered, 3, 4, 5, 6, 7, 8];
        const expected = exhaustive(value, 0, 0, ids);
        assert.equal(expected.osmId, String(ordered[0]));
        assert.deepEqual(value.formationAtLocal(0, 0, { osmIds: ids }), expected);
    }
});

test('far-owner fallback and empty owners keep the unbounded query contract', () => {
    // This diagonal's bounding box touches the query cells although the
    // segment itself is too far away to certify the local search.
    const value = model([line(1, [[-200, 200], [200, -200]]), line(2, [[1000, 1000], [1040, 1000]])]);
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    value.resetSegmentProjectionCount();
    const expected = exhaustive(value, 100, 100, ids), before = value.getSegmentProjectionCount();
    assert.ok(expected.distanceSquared > 80 * 80);
    value.resetSegmentProjectionCount();
    assert.deepEqual(value.formationAtLocal(100, 100, { osmIds: ids, maxDistanceM: 1 }), expected);
    assert.equal(value.getSegmentProjectionCount(), before, 'fallback must not repeat already queried owners');
    assert.equal(value.formationAtLocal(0, 0, { osmIds: ids.map(id => id + 100) }), null);
});

test('culled and absent owners remain dependencies, and captured indexes keep their old answer', () => {
    const value = model(union(16)), before = snapshot(value);
    const ids = [999, ...Array.from({ length: 16 }, (_, i) => i + 1)];
    const evidence = createGroundReadEvidence();
    const old = withGroundReadEvidence(evidence, () => before.formationAtLocal(40, 41, { osmIds: ids }));
    assert.deepEqual(new Set(evidence.ids), new Set(ids.map(String)));
    const frozen = freezeGroundReadEvidence(evidence);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ ids: [16] })), true);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ ids: [999] })), true);
    value.setCenterlineTile('arrival', [line(999, [[30, 41], [50, 41]])]);
    assert.equal(value.formationAtLocal(40, 41, { osmIds: ids }).osmId, '999');
    const after = snapshot(value);
    assert.equal(after.formationAtLocal(40, 41, { osmIds: ids }).osmId, '999');
    assert.deepEqual(before.formationAtLocal(40, 41, { osmIds: ids }), old);
    ids.splice(ids.indexOf(999), 1);
    assert.equal(after.formationAtLocal(40, 41, { osmIds: ids }).osmId, old.osmId,
        'editing a caller-owned array must not retain a stale member set');
    before.release(); after.release();
});
