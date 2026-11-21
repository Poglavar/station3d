// Exercise the production input factory and cooperative road compiler across changing ground generations.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { RoadFormationModel, refineTriangulatedSurface } from '../core/road-formation.js';
import { createRoadRenderGroundCapture, roadRenderQueryBounds } from '../core/road-render-ground.js';
import { drapeEdgeMForTriangulation } from '../core/proposal-ground.js';
import { bikePaintSceneY } from '../core/bike-lane-geometry.js';
import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import { RailFormationModel } from '../core/rail-formation.js';
import { CivilGroundComposition, CIVIL_GROUND_AUTHORITY } from '../core/civil-ground-composition.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';
import { roadProfileTerrainEvidenceYAtLocal } from '../core/rail-road-grade-separation.js';
import { GROUND_SURFACE_LEVELS } from '../world/ground-surface-levels.js';
import { createMappedCoastTerrainSurfaceSampler } from '../core/coastline-mask.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
const anchorLat = 45.8, anchorLon = 16;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(anchorLat * DEG_TO_RAD);
const ll = ([x, z]) => [anchorLon + x / lonScale, anchorLat - z / latScale];
const drain = iterator => { for (;;) { const next = iterator.next(); if (next.done) return next.value; } };
const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const roadRailReadSnapshots ='), source.indexOf('function onTerrainReferenceChanged('));

function fixture({ withRail = true } = {}) {
    let height = 0, revision = 0, current = true;
    const terrain = { get revision() { return revision; },
        sceneYAtLocal: (x, z) => height + x * .02 + z * .08,
        evidenceSceneYAtLocal: (x, z) => height + x * .02 + z * .08,
        absoluteToSceneY: y => y - 100,
        captureReadSnapshot() {
            const h = height;
            const sample = (x, z) => h + x * .02 + z * .08;
            return Object.freeze({ contract: 'station3d-ground-read-snapshot-v1', revision,
                sceneYAtLocal: sample, evidenceSceneYAtLocal: sample, absoluteToSceneY: y => y - 100 });
        } };
    const initial = captureGroundReadSnapshot(terrain);
    const rail = withRail ? new RailFormationModel({ anchorLat, anchorLon,
        baseSceneYAtLocal: initial.evidenceSceneYAtLocal, halfWidthForFeature: () => 4,
        features: [{ properties: { source: 'cb-proposal', proposalId: 'rail' },
            geometry: { type: 'LineString', coordinates: [[-30, 40], [30, 40]].map(ll) } }] }) : null;
    const vertical = new RoadVerticalAlignmentModel({ anchorLat, anchorLon,
        terrainSceneYAtLocal: terrain.evidenceSceneYAtLocal,
        captureTerrainSnapshot: () => captureGroundReadSnapshot(terrain) });
    const civil = new CivilGroundComposition({ terrainSceneYAtLocal: terrain.sceneYAtLocal,
        terrainEvidenceSceneYAtLocal: terrain.evidenceSceneYAtLocal });
    if (rail) {
        const sample = (x, z) => rail.civilGroundSceneYAtLocal(x, z, { surfaceOffsetY: GROUND_SURFACE_LEVELS.tramBed });
        civil.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, { id: 'rail-formation',
            sampleSceneYAtLocal: sample, sampleEvidenceSceneYAtLocal: sample });
    }
    const context = vm.createContext({ captureGroundReadSnapshot, ownReadSnapshot, retainReadSnapshot, roadProfileTerrainEvidenceYAtLocal,
        GROUND_SURFACE_LEVELS, CIVIL_GROUND_AUTHORITY, Map });
    vm.runInContext(code, context);
    const capture = (preparedReads = null) => context.captureRoadFormationBuildInputsSteps({ terrain, civilGround: civil,
        railFormation: rail, verticalAlignments: vertical, authoredPortalReplacements: [], sourcesCurrent: () => current, preparedReads });
    const firstInputs = drain(capture());
    const model = new RoadFormationModel({ anchorLat, anchorLon, ...firstInputs.callbacks, captureBuildInputsSteps: capture });
    model.setCenterlineTile('road', [{ properties: { osm_id: 1, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[-20, 0], [20, 0]].map(ll) } }]);
    model.setSurfaceTile('road', [{ properties: { osm_id: 1, highway_type: 'residential' },
        geometry: { type: 'Polygon', coordinates: [[[-20, -3], [20, -3], [20, 3], [-20, 3], [-20, -3]].map(ll)] } }]);
    return { model, rail, vertical, civil, capture, firstInputs, terrain,
        current: value => { current = value; },
        raise(value) { height = value; revision++; vertical.invalidateTerrain(); model.invalidateTerrain(); } };
}
const staleQueries = model => [model.sceneYAtLocal(0, 0, { osmId: 1, allowStale: true }),
    model.sceneYAtLocal(70, 70, { allowStale: true })];

test('production road input capture reuses read generations and preserves absent rail authority', () => {
    for (const withRail of [true, false]) {
        const f = fixture({ withRail });
        const again = drain(f.capture());
        assert.equal(again.context.railFormation?.getSurfaceProfiles(), f.firstInputs.context.railFormation?.getSurfaceProfiles());
        assert.equal(again.context.verticalAlignments.getAlignments(), f.firstInputs.context.verticalAlignments.getAlignments());
        assert.equal(again.isCurrent(), true);
        assert.ok(Math.abs(again.callbacks.baseSceneYAtLocal(70, 70) - 7) < 1e-12);
        f.raise(5);
        assert.equal(again.isCurrent(), false);
        assert.ok(Math.abs(again.callbacks.baseSceneYAtLocal(70, 70) - 7) < 1e-12);
        assert.ok(Math.abs(drain(f.capture()).callbacks.baseSceneYAtLocal(70, 70) - 12) < 1e-12);
    }
});

function renderCapture(f) {
    const sample = (x, z) => f.model.civilGroundSceneYAtLocal(x, z, { surfaceOffsetYAtProfile: () => .08 });
    f.civil.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, { id: 'road-formation',
        sampleSceneYAtLocal: sample, sampleEvidenceSceneYAtLocal: sample });
    const capture = createRoadRenderGroundCapture({ railSurfaceOffsetY: GROUND_SURFACE_LEVELS.tramBed,
        roadSurfaceOffsetAtProfile: () => .08 });
    return () => capture({ terrain: f.terrain, civilGround: f.civil, roadFormation: f.model, sourcesCurrent: () => true });
}

test('road input and render captures retain the mapped coast replacement generation', () => {
    for (const withEvidence of [false, true]) {
        const f = fixture({ withRail: false });
        const coast = createMappedCoastTerrainSurfaceSampler([
            -2, 10, -2, 2, 10, -2, 2, 10, 2,
            -2, 10, -2, 2, 10, 2, -2, 10, 2,
        ], { bucketSizeM: 4 });
        assert.equal(coast.triangleCount, 2);
        const release = f.civil.setTerrainReplacement({ id: 'mapped-coast',
            sampleSceneYAtLocal: coast, sampleEvidenceSceneYAtLocal: withEvidence ? coast : null,
        });
        const oldInputs = drain(f.capture());
        assert.equal(oldInputs.context.terrainReplacement.id, 'mapped-coast');
        assert.equal(oldInputs.callbacks.sourceTerrainInputSceneYAtLocal(0, 0), 10);
        assert.equal(oldInputs.callbacks.baseSceneYAtLocal(0, 0), withEvidence ? 10 : 0);
        assert.equal(oldInputs.callbacks.sourceTerrainOwnsInputAtLocal(0, 0), true);
        assert.equal(oldInputs.callbacks.baseTerrainReplacementAtLocal(0, 0), true);
        assert.equal(oldInputs.callbacks.sourceTerrainInputSceneYAtLocal(8, 8), .8,
            'outside the coast triangle the raw terrain remains the input');
        assert.equal(oldInputs.callbacks.terrainEvidenceSceneYAtLocal(0, 0), withEvidence ? 10 : 0,
            'terrain evidence follows the captured replacement when supplied');

        const rendered = drain(renderCapture(f)());
        assert.equal(rendered.civilGround.terrainReplacementOwnsAtLocal(0, 0), true);
        assert.equal(rendered.civilGround.sceneYAtLocal(0, 0, {
            throughAuthority: CIVIL_GROUND_AUTHORITY.TERRAIN,
        }), 10);
        assert.equal(rendered.civilGround.sceneYAtLocal(8, 8, {
            throughAuthority: CIVIL_GROUND_AUTHORITY.TERRAIN,
        }), .8);

        const newCoast = createMappedCoastTerrainSurfaceSampler([
            -2, 20, -2, 2, 20, -2, 2, 20, 2,
            -2, 20, -2, 2, 20, 2, -2, 20, 2,
        ], { bucketSizeM: 4 });
        const replace = f.civil.setTerrainReplacement({ id: 'mapped-coast',
            sampleSceneYAtLocal: newCoast, sampleEvidenceSceneYAtLocal: withEvidence ? newCoast : null,
        });
        assert.equal(oldInputs.isCurrent(), false);
        assert.equal(rendered.isCurrent(), false);
        assert.equal(oldInputs.callbacks.sourceTerrainInputSceneYAtLocal(0, 0), 10,
            'an old road input keeps the captured replacement sampler');
        assert.equal(rendered.civilGround.sceneYAtLocal(0, 0, {
            throughAuthority: CIVIL_GROUND_AUTHORITY.TERRAIN,
        }), 10);
        const nextRendered = drain(renderCapture(f)());
        assert.equal(nextRendered.civilGround.sceneYAtLocal(0, 0, {
            throughAuthority: CIVIL_GROUND_AUTHORITY.TERRAIN,
        }), 20);
        release();
        assert.equal(replace(), true);
        assert.equal(oldInputs.context.terrainReplacement.id, 'mapped-coast');
        const nextInputs = drain(f.capture());
        assert.equal(nextInputs.context.terrainReplacement, null);
        assert.equal(nextInputs.callbacks.sourceTerrainInputSceneYAtLocal(0, 0), 0);
        oldInputs.release(); rendered.release(); nextInputs.release(); nextRendered.release();
    }
});

test('concurrent road captures share in-progress work and one cancellation does not discard it', () => {
    const f = fixture({ withRail: false }), capture = renderCapture(f);
    const original = f.model.captureReadSnapshotSteps;
    let builds = 0;
    f.model.captureReadSnapshotSteps = function* (inputs) { builds++; return yield* original.call(this, inputs); };
    const consumers = Array.from({ length: 12 }, () => capture());
    for (const consumer of consumers) assert.equal(consumer.next().done, false);
    consumers.pop().return();
    const results = [];
    while (consumers.length) {
        for (let i = consumers.length - 1; i >= 0; i--) {
            const next = consumers[i].next();
            if (next.done) { results.push(next.value); consumers.splice(i, 1); }
        }
    }
    assert.equal(builds, 1, 'one compiled graph copy regardless of waiting road count');
    assert.equal(results.length, 11);
    assert.ok(results.every(value => value.civilGround === results[0].civilGround
        && value.roadFormation === results[0].roadFormation), 'leases share the compiled graph');
    assert.notEqual(results[0].release, results[1].release, 'each consumer owns its release');
    assert.equal(results[0].isCurrent(), true);
});

test('render capture shares unchanged generations and bounds publication invalidation', () => {
    const f = fixture({ withRail: false });
    f.model.setCenterlineTile('far', [{ properties: { osm_id: 2, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[980, 0], [1020, 0]].map(ll) } }]);
    f.model.setSurfaceTile('far', [{ properties: { osm_id: 2, highway_type: 'residential' },
        geometry: { type: 'Polygon', coordinates: [[[980, -3], [1020, -3], [1020, 3], [980, 3], [980, -3]].map(ll)] } }]);
    const capture = renderCapture(f), old = drain(capture());
    assert.equal(old.isCurrent(), true);
    const repeat = capture().next();
    assert.equal(repeat.done, true);
    assert.equal(repeat.value.roadFormation, old.roadFormation, 'cache hit must not walk the full compiled graph');
    repeat.value.release();
    const current = old.currentWithin({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
    const oldY = old.civilGround.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.PATH, 0, 0);
    assert.equal(oldY, f.civil.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.PATH, 0, 0));
    f.model.setSurfacePublicationReadyForOsmIds(2, false);
    assert.equal(old.isCurrent(), false);
    assert.equal(current(), true, 'a remote owner publishing must not restart this road');
    f.model.setSurfacePublicationReadyForOsmIds(1, false);
    assert.equal(current(), false);
    assert.equal(old.civilGround.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.PATH, 0, 0), oldY);
    const next = drain(capture());
    assert.equal(next.civilGround.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.PATH, 0, 0), 0,
        'a new read generation observes terrain after the road relinquishes support');
    assert.equal(next.isCurrent(), true);
});

test('render query bounds contain complete source geometry and the carriageway query radius', () => {
    const b = roadRenderQueryBounds({ geometry: { coordinates: [[[0, 0], [10, 0], [0, 10]]] },
        properties: { centerline_geometry: { coordinates: [[-100, 0], [100, 0]] }, width_meters: 8 } },
    (x, z) => ({ x, z }));
    assert.deepEqual(b, { minX: -140, maxX: 140, minZ: -40, maxZ: 50 });
});

function geometryRuntime() {
    const runtime = vm.createContext({ THREE, finiteOrNull, refineTriangulatedSurface, drapeEdgeMForTriangulation,
        bikePaintSceneY, CIVIL_GROUND_AUTHORITY, isPermanentTerrainGap, startupTrace: { enabled: false }, profNow: () => 0, profAdd() {},
        // Any accidental module-global height read must fail, not happen to
        // return the same test value as the captured sampler.
        terrainReference: new Proxy({}, { get() { throw new Error('live terrain read'); } }),
        roadFormationModel: new Proxy({}, { get() { throw new Error('live formation read'); } }),
        roadVerticalAlignmentModel: new Proxy({}, { get() { throw new Error('live alignment read'); } }),
    });
    const constants = [...source.matchAll(/^const (?:ENGINEERED_SURFACE_MAX_\w+|DRAPED_SURFACE_MAX_\w+|VERTICAL_ALIGNMENT_SURFACE_MAX_\w+|ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP|BIKE_LANE_GEOMETRY_QUADS_PER_STEP) = [^;]+;/gm)]
        .map(match => match[0]).join('\n');
    vm.runInContext(constants + '\nconst ASPHALT_UV_PER_M = 1 / 16;\n'
        + source.slice(source.indexOf('function applyWorldRoadUvs('), source.indexOf('// Aggregated per-sub-step timing'))
        + source.slice(source.indexOf('function createTerrainConformingRoadGeometryTask('), source.indexOf('function createRoadPolygonGeometryTask('))
        + source.slice(source.indexOf('function createBikeLaneGeometryTask('), source.indexOf('function createBikeLaneGeometry(')), runtime);
    return runtime;
}

test('actual yielded road and bike geometry never mix a changed terrain generation', () => {
    const f = fixture({ withRail: false }), capture = renderCapture(f), ground = drain(capture());
    const runtime = geometryRuntime();
    const seed = new THREE.BufferGeometry();
    seed.setAttribute('position', new THREE.Float32BufferAttribute([-80, -80, 0, 80, -80, 0, 80, 80, 0, -80, 80, 0], 3));
    seed.setIndex([0, 1, 2, 0, 2, 3]);
    const road = runtime.createTerrainConformingRoadGeometryTask(seed, .08, 1, true, false, null, false, false, ground);
    assert.equal(road.step(), 'more'); // seed
    assert.equal(road.step(), 'more'); // refine
    assert.equal(road.step(), 'more'); // partial sample
    const quads = Array.from({ length: 20 }, (_, i) => [
        { x: i * 2, z: 2 }, { x: i * 2 + 2, z: 2 }, { x: i * 2 + 2, z: 3 }, { x: i * 2, z: 3 },
    ]);
    const bike = runtime.createBikeLaneGeometryTask(quads, 1, .08, { ground });
    assert.equal(bike.step(), 'more');
    f.raise(5);
    assert.equal(ground.isCurrent(), false);
    for (const [task, expected] of [[road, (x, z) => ground.roadFormation.sceneYAtLocal(x, z, { osmId: 1 }) + .08],
        [bike, (x, z) => bikePaintSceneY(ground.roadFormation.sceneYAtLocal(x, z, { osmId: 1 }), .08)]]) {
        let count = 0;
        while (task.step() === 'more') assert.ok(++count < 5000);
        const geometry = task.geometry(), positions = geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
            assert.ok(Math.abs(positions.getY(i) - expected(positions.getX(i), positions.getZ(i))) < 2e-5,
                `vertex ${i} must remain on its original input generation`);
        }
        let disposed = 0;
        geometry.addEventListener('dispose', () => disposed++);
        task.dispose(); task.dispose();
        assert.equal(disposed, 1);
    }
});

test('authoritative NoData at one sample excludes the road there; withheld evidence only defers', () => {
    const f = fixture({ withRail: false }), ground = drain(renderCapture(f)()), runtime = geometryRuntime();
    // A pier way: data along most of the ring, NoData past x = 70 (the port basin in the 20 m grid).
    const gapGround = (withheld) => ({ ...ground, terrain: { ...ground.terrain,
        evidenceSceneYAtLocal: (x, z) => x > 70 ? null : ground.terrain.evidenceSceneYAtLocal(x, z),
        hasLoadedCoreCoverageAtLocal: () => true,
        evidenceWithheldAtLocal: (x) => withheld && x > 70 } });
    const run = (task) => { let status; for (let i = 0; i < 10000; i++) { status = task.step(); if (status !== 'more') return status; } assert.fail('never left more'); };
    const seedFor = () => new THREE.PlaneGeometry(160, 20);
    const permanent = runtime.createTerrainConformingRoadGeometryTask(seedFor(), .08, 777, false, false, null, false, false, gapGround(false));
    assert.equal(run(permanent), 'no-data');
    const omission = permanent.omission();
    assert.equal(omission.kind, 'excluded'); assert.equal(omission.reason, 'terrain-evidence');
    assert.ok(omission.x > 70, `the failing sample is named, x=${omission.x}`);
    assert.ok(Number.isFinite(omission.z));
    permanent.dispose();
    const pending = runtime.createTerrainConformingRoadGeometryTask(seedFor(), .08, 777, false, false, null, false, false, gapGround(true));
    assert.equal(run(pending), 'defer', 'a pending detail window is not a permanent gap');
    assert.equal(pending.omission(), null);
    pending.dispose();
});

test('cancelled partial road geometry releases its detached seed exactly once', () => {
    const f = fixture({ withRail: false }), ground = drain(renderCapture(f)()), runtime = geometryRuntime();
    const seed = new THREE.PlaneGeometry(10, 10);
    let disposed = 0;
    seed.addEventListener('dispose', () => disposed++);
    const task = runtime.createTerrainConformingRoadGeometryTask(seed, .08, 1, true, false, null, false, false, ground);
    task.step(); task.step(); task.dispose(); task.dispose();
    assert.equal(disposed, 1);
});

test('every deferred road slice leaves published queries and profiles on their previous inputs', () => {
    const f = fixture();
    const oldProfiles = f.model.getSurfaceProfiles();
    const oldInputs = f.model.getPublishedBuildInputs();
    const before = staleQueries(f.model);
    f.raise(5);
    let steps = 0;
    while (f.model.hasPendingBuild()) {
        const status = f.model.stepPendingBuildPreparation();
        steps++;
        if (status === 'done') break;
        assert.deepEqual(staleQueries(f.model), before);
        assert.equal(f.model.getPublishedBuildInputs(), oldInputs);
        assert.equal(f.model.getSurfaceProfilesForOsmId(1, { allowStale: true })[0], oldProfiles[0]);
    }
    assert.ok(steps > 10);
    const after = staleQueries(f.model);
    for (let i = 0; i < after.length; i++) assert.ok(Math.abs(after[i] - before[i] - 5) < 1e-8);
    assert.notEqual(f.model.getPublishedBuildInputs(), oldInputs);
    assert.notEqual(f.model.getSurfaceProfiles()[0], oldProfiles[0]);
    assert.ok(Math.abs(oldInputs.callbacks.baseSceneYAtLocal(70, 70) - 7) < 1e-12);
});

test('stale or failed road inputs retain the complete publication and are retried', () => {
    const f = fixture();
    const old = f.model.getSurfaceProfiles();
    const before = staleQueries(f.model);
    f.raise(5);
    do { f.model.stepPendingBuildPreparation(); } while (f.model._pendingBuildPreparation.phase === 'capture-inputs');
    f.current(false);
    assert.throws(() => f.model.stepPendingBuildPreparation(), { code: 'formation-inputs-stale' });
    assert.equal(f.model.hasPendingBuild(), true);
    assert.deepEqual(staleQueries(f.model), before);
    assert.equal(f.model.getSurfaceProfilesForOsmId(1, { allowStale: true })[0], old[0]);
    assert.equal(f.model._pendingBuildPreparation, null);
    f.current(true);
    f.model.captureBuildInputsSteps = function* () { yield; throw new Error('capture failed'); };
    f.model.stepPendingBuildPreparation();
    assert.throws(() => f.model.stepPendingBuildPreparation(), /capture failed/);
    assert.deepEqual(staleQueries(f.model), before);
    f.model.captureBuildInputsSteps = f.capture;
    while (f.model.hasPendingBuild()) f.model.stepPendingBuildPreparation();
    assert.ok(Math.abs(staleQueries(f.model)[0] - before[0] - 5) < 1e-8);
});

test('failure preparing publication tables preserves every active query and version before retry', () => {
    const f = fixture({ withRail: false });
    const profiles = f.model.getSurfaceProfiles(), before = staleQueries(f.model);
    const inputs = f.model.getPublishedBuildInputs(), versions = f.model._surfaceGeometryVersions;
    const changes = f.model._surfaceGeometryChanges, revision = f.model.surfaceGeometryRevision;
    f.raise(5);
    const original = f.model._prepareSurfacePublicationSteps;
    f.model._prepareSurfacePublicationSteps = function* (task) {
        yield* original.call(this, task);
        throw new Error('publication allocation failed');
    };
    assert.throws(() => {
        while (f.model.hasPendingBuild()) {
            f.model.stepPendingBuildPreparation();
            assert.deepEqual(staleQueries(f.model), before);
            assert.equal(f.model.getPublishedBuildInputs(), inputs);
            assert.equal(f.model._surfaceGeometryVersions, versions);
            assert.equal(f.model._surfaceGeometryChanges, changes);
        }
    }, /publication allocation failed/);
    assert.equal(f.model._profiles, profiles);
    assert.equal(f.model.surfaceGeometryRevision, revision);
    assert.deepEqual(staleQueries(f.model), before);
    f.model._prepareSurfacePublicationSteps = original;
    while (f.model.hasPendingBuild()) f.model.stepPendingBuildPreparation();
    assert.ok(Math.abs(staleQueries(f.model)[0] - before[0] - 5) < 1e-8);
    assert.ok(f.model.surfaceGeometryRevision > revision);
});

test('missing captured context and malformed validity callbacks fail before compilation', () => {
    for (const fields of [{ context: null }, { context: undefined }, { context: {} }, { isCurrent: true }]) {
        const f = fixture({ withRail: false });
        f.model.getSurfaceProfiles();
        const before = staleQueries(f.model);
        f.raise(5);
        f.model.captureBuildInputsSteps = function* () { return { ...f.firstInputs, ...fields }; };
        assert.throws(() => f.model.stepPendingBuildPreparation(), TypeError);
        assert.deepEqual(staleQueries(f.model), before);
    }
});

test('a prepared road generation cannot be stolen by live queries and rolls back its query tables', () => {
    const f = fixture({ withRail: false }), oldProfiles = f.model.getSurfaceProfiles();
    const oldInputs = f.model.getPublishedBuildInputs(), before = staleQueries(f.model);
    const oldVersion = f.model.getSurfaceGeometryGeneration(1);
    f.raise(5);
    const iterator = f.model.preparePublicationSteps();
    let tx, steps = 0;
    for (;;) {
        const next = iterator.next();
        assert.deepEqual(staleQueries(f.model), before);
        assert.equal(f.model.getSurfaceProfiles(), oldProfiles, 'ordinary query retains the visible generation');
        assert.equal(f.model.stepPendingBuildPreparation(), 'held', 'another queue cannot steal the prepared swap');
        if (next.done) { tx = next.value; break; }
        assert.ok(++steps < 10000);
    }
    assert.ok(steps > 1);
    assert.equal(tx.state, 'prepared'); assert.equal(tx.isCurrent(), true);
    assert.deepEqual(staleQueries(tx.read), before.map(y => y + 5));
    assert.equal(f.model.getPublishedBuildInputs(), oldInputs);
    assert.equal(tx.commit(), true);
    assert.deepEqual(staleQueries(f.model), staleQueries(tx.read));
    assert.equal(f.model.getSurfaceGeometryGeneration(1), tx.read.getSurfaceGeometryGeneration(1));
    assert.equal(tx.rollback(), true);
    assert.deepEqual(staleQueries(f.model), before);
    assert.equal(f.model.getSurfaceGeometryGeneration(1), oldVersion);
    assert.equal(f.model.getPublishedBuildInputs(), oldInputs);
    assert.equal(tx.commit(), true); assert.equal(tx.finalize(), true);
    assert.equal(tx.finalize(), false); assert.equal(tx.rollback(), false);
    assert.equal(f.model.stepPendingBuildPreparation(), 'done');
    assert.equal(drain(f.model.preparePublicationSteps()), null, 'unchanged compilation is a no-op');
});

test('coordinator validation preserves the immutable road publication contract and live state accessor', () => {
    const f=fixture({withRail:false});f.model.getSurfaceProfiles();f.raise(5);
    const tx=drain(f.model.preparePublicationSteps());
    const graphSource=readFileSync(new URL('../world/ground-generations.js',import.meta.url),'utf8');
    const keepCode=graphSource.slice(graphSource.indexOf('    function keep(resource,'),graphSource.indexOf('    function metadata('));
    const owned=[],ownedLabels=[];
    const keep=Function('owned','ownedLabels','checkRead','fail',`${keepCode};return keep;`)(owned,ownedLabels,check=>check(),()=>assert.fail('missing resource'));
    const guarded=keep(tx),capture=createRoadRenderGroundCapture({railSurfaceOffsetY:.1,roadSurfaceOffsetAtProfile:()=>.08});
    let read;
    try {
        assert.equal(Object.isFrozen(guarded),true,'prepared rendering accepts only an immutable publication');
        assert.equal(guarded.inputs,tx.inputs);assert.equal(guarded.read,tx.read);
        read=drain(capture({terrain:f.terrain,civilGround:f.civil,roadFormation:f.model,
            sourcesCurrent:()=>true,preparedFormation:guarded,preparedRailFormation:null}));
        assert.equal(read.isCurrent(),true);assert.equal(guarded.state,'prepared');
        assert.equal(guarded.commit(),true);assert.equal(guarded.state,'committed');
        assert.equal(guarded.rollback(),true);assert.equal(guarded.state,'prepared');
        assert.equal(guarded.commit(),true);assert.equal(guarded.finalize(),true);assert.equal(guarded.state,'published');
    } finally {read?.release();capture.clear();tx.discard();f.model.dispose();}
});

test('cancelled or superseded road publications keep old support and release the compiler for retry', () => {
    for (const revise of ['terrain', 'publication', 'source', 'cancel']) {
        const f = fixture({ withRail: false }); f.model.getSurfaceProfiles();
        const before = staleQueries(f.model); f.raise(5);
        if (revise === 'cancel') {
            const partial = f.model.preparePublicationSteps();
            assert.equal(partial.next().done, false); partial.return();
        } else {
            const tx = drain(f.model.preparePublicationSteps());
            if (revise === 'terrain') f.raise(2);
            else if (revise === 'publication') f.model.setSurfacePublicationReadyForOsmIds(1, false);
            else f.model.removeSurfaceTile('road');
            assert.equal(tx.isCurrent(), false); assert.equal(tx.commit(), false);
            assert.deepEqual(staleQueries(f.model), before);
            assert.equal(tx.discard(), true); assert.equal(tx.discard(), false);
        }
        const retry = drain(f.model.preparePublicationSteps());
        assert.equal(retry.isCurrent(), true); assert.equal(retry.commit(), true); assert.equal(retry.finalize(), true);
        assert.deepEqual(staleQueries(f.model), staleQueries(retry.read));
    }
});

test('the coordinator supplies captured road dependencies and upstream promotion does not reject its own group',()=>{
    const f=fixture(),oldProfiles=f.model.getSurfaceProfiles(),before=staleQueries(f.model);
    f.raise(5);
    const inputs=drain(f.capture());
    const graph=Object.freeze(Object.fromEntries(['terrain','railFormation','verticalAlignments','terrainReplacement']
        .map(key=>[key,inputs.context[key]])));
    const poison=()=>{throw new Error('active input recaptured inside a candidate');};
    f.terrain.captureReadSnapshot=poison;f.rail.captureReadSnapshotSteps=poison;
    f.vertical.getAlignments=poison;f.vertical.captureReadSnapshotSteps=poison;
    f.civil.captureTerrainReplacementReadSnapshot=poison;f.model.captureBuildInputsSteps=poison;
    const registry=createSurfacePublicationRegistry();
    try {
        for(const failure of [true,false]) {
            const tx=drain(f.model.preparePublicationSteps({captureBuildInputsSteps:()=>f.capture(graph)}));
            assert.deepEqual(staleQueries(f.model),before);
            assert.equal(f.model.getSurfaceProfiles(),oldProfiles);
            assert.deepEqual(staleQueries(tx.read),before.map(y=>y+5));
            const generation=failure?1:2;
            const batch=registry.prepareBatch([
                {ticket:registry.begin({key:'upstream',generation}),clear:true,
                    commit(){f.current(false);return true;},rollback(){f.current(true);}},
                {ticket:registry.begin({key:'road-formation',generation}),clear:true,isCurrent:tx.isCurrent,
                    commit:tx.commit,rollback:tx.rollback,discard:tx.discard},
            ],{commit(){if(failure)throw new Error('late-member-failure');}});
            if(failure) {
                assert.throws(()=>batch.publish(),/late-member-failure/);
                assert.deepEqual(staleQueries(f.model),before);
                assert.equal(f.model.getSurfaceProfiles(),oldProfiles);
            } else {
                assert.equal(batch.publish().status,'published');assert.equal(tx.finalize(),true);
                assert.deepEqual(staleQueries(f.model),before.map(y=>y+5));
            }
        }
    } finally { f.model.dispose();inputs.release();f.firstInputs.release();f.vertical.dispose(); }
});

test('disposing formation preparation closes captured query owners even if its generator is resumed',()=>{
    const f=fixture({withRail:false});f.model.getSurfaceProfiles();f.raise(5);
    let readers=0;
    const owned=()=>{
        readers++;let released=false;
        return Object.freeze({retain:owned,release(){if(released)return false;released=true;readers--;return true;}});
    };
    const original=drain(f.capture());
    const capture=function*(){return ownReadSnapshot({context:original.context,callbacks:original.callbacks,isCurrent:()=>true},[owned()]);};
    const steps=f.model.preparePublicationSteps({captureBuildInputsSteps:capture});
    for(let n=0;;n++) {
        assert.ok(n<10000);
        const step=steps.next();assert.equal(step.done,false);
        if(step.value?.phase==='formation-query-profile-end')break;
    }
    assert.equal(readers,2,'compiler and pending query each own the candidate input');
    f.model.dispose();assert.equal(readers,0);
    assert.throws(()=>steps.next(),{code:'formation-inputs-stale'});
    assert.equal(readers,0,'resuming cannot resurrect or double-release the query');
    original.release();f.firstInputs.release();f.vertical.dispose();
});

test('actual receiver geometry and prepared road queries commit or roll back in the same registry batch', () => {
    const f = fixture({ withRail: false }), scene = new THREE.Scene();
    f.model.getSurfaceProfiles();
    const registry = createSurfacePublicationRegistry(), runtime = geometryRuntime();
    const initial = drain(renderCapture(f)());
    let generation = 0, discarded = 0;
    function build(ground) {
        const task = runtime.createTerrainConformingRoadGeometryTask(new THREE.PlaneGeometry(20, 6),
            .08, 1, true, false, null, false, false, ground);
        while (task.step() === 'more') {}
        const mesh = new THREE.Mesh(task.geometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        markSurfaceClaim(mesh, { surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
            ownerId: 'road-1', replacementKey: 'road-1', generation: ++generation,
            verticalBand: 'ground', supportReady: true });
        return mesh;
    }
    const retire = (_context, mesh) => { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); };
    const oldRoot = build(initial);
    registry.begin({ key: 'road-1', generation, parent: scene, retire }).publish(oldRoot);
    const rayY = () => {
        scene.updateMatrixWorld(true);
        const ray = new THREE.Raycaster(new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, -1, 0));
        return ray.intersectObjects(scene.children)[0]?.point.y;
    };
    const oldY = rayY(), observations = [];
    registry.subscribe(() => observations.push([f.model.sceneYAtLocal(0, 0, { osmId: 1 }), rayY(), scene.children.length]));
    f.raise(5);
    for (const failure of [true, false]) {
        const tx = drain(f.model.preparePublicationSteps());
        const root = build({ ...tx.inputs.context, roadFormation: tx.read });
        const batch = registry.prepareBatch([{ ticket: registry.begin({ key: 'road-1', generation, parent: scene, retire }),
            root, isCurrent: tx.isCurrent, commit: tx.commit, rollback: tx.rollback,
            discard(context, mesh) { discarded++; retire(context, mesh); tx.discard(); },
        }], { commit() { if (failure) throw new Error('later participant failed'); } });
        assert.equal(rayY(), oldY);
        assert.ok(Math.abs(f.model.sceneYAtLocal(0, 0, { osmId: 1 }) - (oldY - .08)) < 1e-6);
        if (failure) {
            assert.throws(() => batch.publish(), /later participant failed/);
            assert.equal(scene.children[0], oldRoot); assert.equal(rayY(), oldY);
            assert.equal(observations.length, 0); assert.equal(discarded, 1);
        } else {
            assert.equal(batch.publish().status, 'published'); assert.equal(tx.finalize(), true);
            assert.equal(scene.children[0], root); assert.equal(scene.children.length, 1);
            assert.ok(Math.abs(rayY() - oldY - 5) < 1e-6);
            assert.equal(observations.length, 1);
            assert.ok(Math.abs(observations[0][1] - observations[0][0] - .08) < 1e-6);
        }
    }
    registry.close();
});
