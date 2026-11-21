// A compiled alignment's cached rows and analytic queries must retain the same terrain generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const anchorLat = 45.8, anchorLon = 16;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(anchorLat * DEG_TO_RAD);
const ll = (x, z) => [anchorLon + x / lonScale, anchorLat - z / latScale];
function grid(offset = 0) {
    const side = 81, step = 10, min = -100;
    const values = new Uint16Array(side ** 2);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
        const shift = typeof offset === 'function' ? offset(min + x * step, min + z * step) : offset;
        values[z * side + x] = Math.round((100 + shift + (min + x * step) * .02 + (min + z * step) * .1) * 100);
    }
    return new TerrainGrid({ grid: { width: side, height: side, bounds: {
        west: ll(min - step / 2, 0)[0], east: ll(min + (side - .5) * step, 0)[0],
        north: ll(0, min - step / 2)[1], south: ll(0, min + (side - .5) * step)[1],
    } }, encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } }, values.buffer);
}
function fixture(kind = 'underpass') {
    const terrain = new TerrainReference(grid(), anchorLon, anchorLat, { surfaceStepM: 20 });
    let captures = 0;
    const model = new RoadVerticalAlignmentModel({
        anchorLon, anchorLat, terrainSceneYAtLocal: (x, z) => terrain.evidenceSceneYAtLocal(x, z),
        absoluteToSceneY: y => terrain.absoluteToSceneY(y),
        captureTerrainSnapshot: () => { captures++; return captureGroundReadSnapshot(terrain); },
        definitions: [{ id: 'test', kind, memberOsmIds: [1], axis: [ll(0, 0), ll(400, 0)],
            profile: kind === 'underpass' ? { type: 'terrain-offset', offsetM: -5 }
                : { type: 'relative-peak', peakOffsetM: 6 },
            structureRange: { start: { distanceM: 150 }, end: { distanceM: 250 } },
            replaceRoadSurface: true, structureMode: 'open-cut' }],
    });
    return { model, terrain, captures: () => captures };
}

test('compiled road profiles keep queries, rows and approach envelopes on captured terrain', () => {
    for (const kind of ['underpass', 'overpass']) {
        const { model, terrain, captures } = fixture(kind);
        const first = model.getAlignments()[0];
        const before = first.samples.map(sample => first.profileYAtS(sample.s));
        const roads = [10, 100, 200, 390].map(x => model.roadYAtLocal(x, 3, 1));
        const cutouts = structuredClone(model.getReplacementTerrainCutoutRegions());
        assert.deepEqual(before, first.samples.map(sample => sample.y));
        terrain.replaceGrid(grid(10));
        assert.deepEqual(first.samples.map(sample => first.profileYAtS(sample.s)), before);
        assert.deepEqual([10, 100, 200, 390].map(x => model.roadYAtLocal(x, 3, 1)), roads);
        assert.deepEqual(model.getReplacementTerrainCutoutRegions(), cutouts);
        assert.equal(captures(), 1);
        assert.equal(model.invalidateTerrain([{ minX: 1000, minZ: 1000, maxX: 1100, maxZ: 1100 }]).changed, false);
        assert.equal(model.getAlignments()[0], first);
        const change = model.invalidateTerrain([{ minX: -10, minZ: -10, maxX: 410, maxZ: 10 }]);
        assert.equal(change.changed, true);
        assert.deepEqual(change.osmIds, ['1']);
        const second = model.getAlignments()[0];
        assert.notEqual(second, first);
        assert.equal(captures(), 2);
        assert.deepEqual(first.samples.map(sample => first.profileYAtS(sample.s)), before);
        for (let i = 0; i < second.samples.length; i++) {
            assert.ok(Math.abs(second.samples[i].y - second.profileYAtS(second.samples[i].s)) < 1e-9);
            assert.ok(Math.abs(second.samples[i].y - first.samples[i].y - 10) < 1e-8);
        }
        assert.deepEqual(model.getChangesSince(0).ids, ['test']);
    }
});

test('failed or invalid capture retains the complete old alignment generation and can retry', () => {
    const { model, terrain } = fixture();
    const original = model.getAlignments()[0];
    terrain.replaceGrid(grid(20));
    model.invalidateTerrain();
    const capture = model.captureTerrainSnapshot;
    model.captureTerrainSnapshot = () => { throw new Error('source unavailable'); };
    assert.throws(() => model.getAlignments(), /source unavailable/);
    assert.equal(model._compiled[0], original);
    assert.equal(model._dirty, true);
    model.captureTerrainSnapshot = () => ({ contract: 'station3d-terrain-read-snapshot-v1' });
    assert.throws(() => model.getAlignments(), /captured terrain/);
    assert.equal(model._compiled[0], original);
    model.captureTerrainSnapshot = capture;
    assert.notEqual(model.getAlignments()[0], original);
    assert.equal(model._dirty, false);
});

test('bounded terrain invalidation retains other compiled alignments and their sampler', () => {
    const { model, terrain } = fixture('overpass');
    model.setCenterlineTile('second', [{ properties: { osm_id: 2, highway: 'secondary', bridge: 'yes' },
        geometry: { type: 'LineString', coordinates: [ll(0, 80), ll(400, 80)] } }]);
    const first = model.getAlignmentForOsmId(1), second = model.getAlignmentForOsmId(2);
    assert.ok(second);
    const secondY = model.roadYAtLocal(20, 83, 2);
    terrain.replaceGrid(grid((_x, z) => z < 40 ? 10 : 0));
    const change = model.invalidateTerrain([{ minX: -10, maxX: 410, minZ: -10, maxZ: 40 }]);
    assert.deepEqual(change.osmIds, ['1']);
    assert.notEqual(model.getAlignmentForOsmId(1), first);
    assert.equal(model.getAlignmentForOsmId(2), second);
    assert.equal(model.roadYAtLocal(20, 83, 2), secondY);
    model.setCenterlineTile('third', [{ properties: { osm_id: 3, highway: 'secondary', bridge: 'yes' },
        geometry: { type: 'LineString', coordinates: [ll(0, 150), ll(400, 150)] } }]);
    const replacement = model.getAlignmentForOsmId(1);
    assert.equal(model.getAlignmentForOsmId(2), second);
    assert.notEqual(replacement, first);
});

const drain = iterator => { for (;;) { const next = iterator.next(); if (next.done) return next.value; } };
test('alignment query capture retains portals and profiles through later source updates', () => {
    const { model, terrain } = fixture();
    model.getAlignments();
    const portal = { alignmentId: 'test', replacementBackstopReady: false,
        selectionBounds: { minX: -10, minZ: -10, maxX: 410, maxZ: 10 } };
    let clock = 0;
    const pending = model.captureReadSnapshotSteps({ authoredPortalReplacements: [portal], now: () => clock += .3 });
    assert.equal(pending.next().done, false);
    portal.replacementBackstopReady = true;
    const captured = drain(pending);
    const originalY = captured.roadYAtLocal(100, 0, 1);
    const originalCutouts = structuredClone(captured.getReplacementTerrainCutoutRegions());
    assert.ok(originalCutouts.some(region => region.cutoutBounds));
    assert.equal(captured.setCenterlineTile, undefined);
    assert.equal(captured.invalidateTerrain, undefined);
    assert.throws(() => { captured.getAlignments()[0].kind = 'wrong'; }, TypeError);
    assert.equal(captured.getAlignments()[0].points, model.getAlignments()[0].points);
    terrain.replaceGrid(grid(20));
    model.invalidateTerrain();
    assert.notEqual(model.roadYAtLocal(100, 0, 1), originalY);
    assert.equal(captured.roadYAtLocal(100, 0, 1), originalY);
    assert.deepEqual(captured.getReplacementTerrainCutoutRegions(), originalCutouts);
    assert.equal(captured.getProfileOwnerForOsmId(1), captured.getAlignmentForOsmId(1));
    const stale = model.captureReadSnapshotSteps({ authoredPortalReplacements: [], now: () => clock += .3 });
    stale.next();
    model.invalidateTerrain();
    assert.throws(() => drain(stale), { code: 'road-alignment-snapshot-stale' });
    assert.throws(() => drain(model.captureReadSnapshotSteps({ authoredPortalReplacements: [] })), /Complete a captured/);
});
