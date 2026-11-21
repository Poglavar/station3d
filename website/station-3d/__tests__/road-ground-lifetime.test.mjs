// Actual tiled terrain, production road input factory and compiler/cache.
// A read must survive its producer's retirement, then leave the source budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureGroundReadSnapshot, captureTerrainReadSnapshot } from '../core/terrain-snapshot.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';
import { compileTerrainRenderPacket } from '../core/compilers/terrain-render-packet.js';
import { RoadFormationModel } from '../core/road-formation.js';
import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import { RailFormationModel } from '../core/rail-formation.js';
import { createRailCutEdgeEvaluator } from '../core/curb-rail-cut.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, setFrameChunkSchedulerMode } from '../core/frame-chunk-queue.js';
import { createRoadRenderGroundCapture } from '../core/road-render-ground.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { CivilGroundComposition, CIVIL_GROUND_AUTHORITY } from '../core/civil-ground-composition.js';
import { roadProfileTerrainEvidenceYAtLocal } from '../core/rail-road-grade-separation.js';
import { GROUND_SURFACE_LEVELS } from '../world/ground-surface-levels.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('const roadRailReadSnapshots ='), source.indexOf('function onTerrainReferenceChanged('));
const drain = iterator => { for (;;) { const step = iterator.next(); if (step.done) return step.value; } };
const lat = 45.8, lon = 16, tileM = 80, segments = tileM / 20;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(lat * DEG_TO_RAD);
function grid(height) {
    const values = new Uint16Array(49);
    for (let z = 0; z < 7; z++) for (let x = 0; x < 7; x++) {
        values[z * 7 + x] = Math.round((typeof height === 'function' ? height(x * 20 - 20, z * 20 - 20) : height) * 100);
    }
    return new TerrainGrid({ grid: { width: 7, height: 7, bounds: {
        west: lon - 30 / lonScale, east: lon + 110 / lonScale,
        north: lat + 30 / latScale, south: lat - 110 / latScale,
    } }, encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } }, values.buffer);
}
function fixture(maxReadSnapshots = 64) {
    const raw = new TerrainReference(grid(102), lon, lat, { surfaceStepM: 20 });
    raw.anchorHeightM = 100;
    const terrain = createPublishedTerrainReference(captureTerrainReadSnapshot(raw), {
        tileM, maxTiles: 4, maxChangedTiles: 4, maxSnapshots: 8, maxReadSnapshots,
        maxSourceBytes: 100000, maxReceiverBytes: 1000000, maxSegments: 20,
    });
    function publish(height) {
        raw.replaceGrid(grid(height));
        const snapshot = captureTerrainReadSnapshot(raw);
        const packet = compileTerrainRenderPacket({ sourceRevision: `fixture:${raw.revision}`, generation: raw.revision,
            tile: { matrix: 'station3d-local-metre-v1', z: 0, x: 0, y: 0, originLon: lon, originLat: lat, sizeM: tileM },
            inputs: { snapshotRevision: snapshot.revision, tileX: 0, tileZ: 0, tileM, segments, uvPerM: .1 },
        }, snapshot).primitives[0];
        const tx = drain(terrain.prepareSteps([{ tileX: 0, tileZ: 0, snapshot, segments,
            positions: packet.positions, indices: packet.indices }]));
        assert.equal(tx.commit(), true); assert.equal(tx.notify(), true);
    }
    publish(102);
    const civil = new CivilGroundComposition({ terrainSceneYAtLocal: terrain.sceneYAtLocal,
        terrainEvidenceSceneYAtLocal: terrain.evidenceSceneYAtLocal });
    const runtime = vm.createContext({ captureGroundReadSnapshot, ownReadSnapshot, retainReadSnapshot,
        CIVIL_GROUND_AUTHORITY, GROUND_SURFACE_LEVELS, roadProfileTerrainEvidenceYAtLocal, Map });
    vm.runInContext(factory, runtime);
    let sourceRail = null;
    const captureInputs = () => runtime.captureRoadFormationBuildInputsSteps({ terrain, civilGround: civil,
        railFormation: sourceRail, verticalAlignments: null, sourcesCurrent: () => true });
    const model = new RoadFormationModel({ anchorLat: lat, anchorLon: lon,
        baseSceneYAtLocal: terrain.evidenceSceneYAtLocal, captureBuildInputsSteps: captureInputs });
    const capture = createRoadRenderGroundCapture({ railSurfaceOffsetY: .1, roadSurfaceOffsetAtProfile: () => .08 });
    return { terrain, model, capture, civil,
        setRail(rail) { sourceRail = rail; model.invalidateTerrain(); },
        read: (preparedFormation = null, preparedRailFormation = undefined) => capture({ terrain, civilGround: civil, roadFormation: model,
            sourcesCurrent: () => true, preparedFormation, preparedRailFormation }),
        replace(height) { publish(height); model.invalidateTerrain(); },
        retire() { capture.clear(); model.dispose(); runtime.clearRoadInputReadSnapshots(); },
    };
}
const y = read => read.sceneYAtLocal(10, 10);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('a live road capture keeps its terrain after cache/model retirement and releases the last old source', () => {
    const f = fixture(), old = drain(f.read());
    near(y(old.terrain), 2); near(y(old.roadFormation), 2);
    f.replace(107);
    const current = drain(f.read());
    near(y(current.terrain), 7); near(y(current.roadFormation), 7);
    assert.equal(f.terrain.usage().residentSnapshots, 2, 'unfinished geometry still owns the old source');
    current.release();
    f.retire();
    near(y(old.terrain), 2); near(y(old.roadFormation), 2);
    assert.ok(f.terrain.usage().readSnapshots > 0);
    assert.equal(old.release(), true); assert.equal(old.release(), false);
    assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(f.terrain.usage().residentSnapshots, 1, 'only published terrain remains resident');
    assert.throws(() => y(old.terrain), { code: 'terrain-read-released' });
    f.terrain.close();
});

test('cancel, rollback and discard release road candidates while preserving the active input owner', () => {
    const f = fixture(); f.model.getSurfaceProfiles();
    const activeOwners = f.terrain.usage().readSnapshots;
    f.replace(107);
    const cancelled = f.model.preparePublicationSteps();
    assert.equal(cancelled.next().done, false);
    assert.ok(f.terrain.usage().readSnapshots > activeOwners);
    cancelled.return();
    assert.equal(f.terrain.usage().readSnapshots, activeOwners);
    near(y(f.model), 2);
    const tx = drain(f.model.preparePublicationSteps());
    assert.equal(tx.commit(), true); near(y(f.model), 7);
    assert.equal(tx.rollback(), true); near(y(f.model), 2);
    assert.equal(tx.discard(), true); assert.equal(tx.discard(), false);
    assert.equal(f.terrain.usage().readSnapshots, activeOwners);
    assert.throws(() => y(tx.read), { code: 'terrain-read-released' });
    const retry = drain(f.model.preparePublicationSteps());
    assert.equal(retry.commit(), true); assert.equal(retry.finalize(), true);
    near(y(f.model), 7);
    assert.equal(f.terrain.usage().readSnapshots, activeOwners);
    f.retire(); assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('prepared rendering consumes the coordinator graph without draining active models and owns it through cancellation', () => {
    const f = fixture(), old = drain(f.read());
    f.replace(107);
    const tx = drain(f.model.preparePublicationSteps());
    const captureInputs = f.model.captureBuildInputsSteps;
    const captureQuery = f.model.captureReadSnapshotSteps;
    const stepPreparation = f.model.stepPendingBuildPreparation;
    f.model.captureBuildInputsSteps = f.model.captureReadSnapshotSteps = f.model.stepPendingBuildPreparation = () => {
        throw new Error('prepared renderer read the active model');
    };
    const candidate = drain(f.read(tx));
    near(y(candidate.terrain), 7); near(y(candidate.roadFormation), 7);
    near(y(old.terrain), 2); near(y(f.model), 2);
    assert.equal(candidate.currentWithin({ minX: 0, minZ: 0, maxX: 20, maxZ: 20 })(), true);
    assert.equal(tx.discard(), true);
    assert.equal(candidate.isCurrent(), false);
    near(y(candidate.terrain), 7); near(y(candidate.roadFormation), 7);
    f.model.captureBuildInputsSteps = captureInputs;
    f.model.captureReadSnapshotSteps = captureQuery;
    f.model.stepPendingBuildPreparation = stepPreparation;
    const retry = drain(f.model.preparePublicationSteps()), next = drain(f.read(retry));
    assert.equal(retry.commit(), true); assert.equal(retry.finalize(), true);
    const active = drain(f.read());
    near(y(active.terrain), 7); near(y(active.roadFormation), 7);
    active.release(); f.retire();
    near(y(candidate.roadFormation), 7); near(y(next.roadFormation), 7);
    candidate.release(); next.release(); old.release();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('prepared rendering releases partial owners if upstream validity changes during civil capture', () => {
    const f = fixture(), old = drain(f.read());
    f.replace(107);
    const tx = drain(f.model.preparePublicationSteps());
    const owners = f.terrain.usage().readSnapshots;
    const invalid = Object.freeze({ ...tx, isCurrent: () => false });
    assert.throws(() => drain(f.read(invalid)), { code: 'road-render-ground-stale' });
    assert.equal(f.terrain.usage().readSnapshots, owners);
    near(y(old.terrain), 2); near(y(f.model), 2);
    tx.discard(); f.retire(); old.release();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('road profiles retain construction ground while the prepared path receiver uses final rail ownership', () => {
    const f = fixture(), terrain = f.terrain.captureReadSnapshot('rail-construction');
    const coordinates = [10, 60].map(x => [lon + x / lonScale, lat - 40 / latScale, 4]);
    const rail = new RailFormationModel({ anchorLat: lat, anchorLon: lon,
        features: [{ properties: { source: 'cb-proposal', proposalId: 'receiver', elevationMode: 'absolute', elevationDatum: 'EVRF2000' },
            geometry: { type: 'LineString', coordinates } }],
        readInputs: terrain, baseSceneYAtLocal: terrain.evidenceSceneYAtLocal, absoluteSceneYAtHeight: y => y,
    });
    terrain.release();
    f.setRail(rail);
    f.civil.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, { id: 'rail-formation',
        sampleSceneYAtLocal: rail.civilGroundSceneYAtLocal.bind(rail),
        sampleEvidenceSceneYAtLocal: rail.civilGroundSceneYAtLocal.bind(rail) });
    const tx = drain(f.model.preparePublicationSteps());
    const finalModel = drain(rail.forkCompiledGenerationSteps());
    for (const profile of finalModel.profiles) profile.internalSegments.fill(true);
    const finalRead = drain(finalModel.captureReadSnapshotSteps({ baseSceneYAtLocal: finalModel.baseSceneYAtLocal }));
    const baselineOwners = f.terrain.usage().readSnapshots;
    assert.throws(() => drain(f.read(Object.freeze({ ...tx, isCurrent: () => false }), finalRead)), { code: 'road-render-ground-stale' });
    assert.equal(f.terrain.usage().readSnapshots, baselineOwners, 'failed final-rail capture releases its partial owner');
    const candidate = drain(f.read(tx, finalRead));
    const witness = [];
    for (let z = 30; z < 40; z += .1) {
        const constructed = tx.inputs.context.railFormation.civilGroundSceneYAtLocal(35, z);
        if (constructed !== null && finalRead.civilGroundSceneYAtLocal(35, z) === null) witness.push({ z, constructed });
    }
    assert.ok(witness.length > 0);
    const { z, constructed } = witness[0];
    assert.equal(candidate.railFormation.civilGroundSceneYAtLocal(35, z), null);
    near(candidate.constructionRailFormation.civilGroundSceneYAtLocal(35, z), constructed);
    near(candidate.civilGround.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.PATH, 35, z), 2);
    near(tx.inputs.context.railFormation.civilGroundSceneYAtLocal(35, z), constructed);
    finalRead.release(); finalModel.dispose(); rail.dispose(); tx.discard(); f.retire();
    assert.equal(candidate.railFormation.civilGroundSceneYAtLocal(35, z), null);
    near(candidate.constructionRailFormation.civilGroundSceneYAtLocal(35, z), constructed);
    near(candidate.terrain.sceneYAtLocal(35, z), 2);
    candidate.release();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('a waiting road consumer survives cache replacement after its shared capture finished', () => {
    const f = fixture(), a = f.read(), b = f.read();
    assert.equal(a.next().done, false); assert.equal(b.next().done, false);
    const first = drain(a); first.release();
    f.replace(107);
    const current = drain(f.read());
    const waiting = drain(b);
    near(y(current.terrain), 7); near(y(waiting.terrain), 2);
    current.release(); f.retire();
    near(y(waiting.roadFormation), 2);
    waiting.release();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('a partly acquired derived road owner rolls back when the terrain read budget is full', () => {
    const f = fixture(9), original = drain(f.read());
    const retained = original.retain('second-road');
    const before = f.terrain.usage().readSnapshots;
    assert.throws(() => original.retain('over-budget-road'), { code: 'terrain-publication-capacity' });
    assert.equal(f.terrain.usage().readSnapshots, before);
    near(y(original.terrain), 2); near(y(retained.roadFormation), 2);
    retained.release(); original.release(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

const ll = (x, z) => [lon + x / lonScale, lat - z / latScale];
function alignmentModel(terrain) {
    return new RoadVerticalAlignmentModel({ anchorLon: lon, anchorLat: lat,
        terrainSceneYAtLocal: terrain.evidenceSceneYAtLocal,
        captureTerrainSnapshot: () => captureGroundReadSnapshot(terrain, 'alignment-build'),
        definitions: [10, 50].map((z, i) => ({ id: `alignment-${i + 1}`, kind: 'overpass', memberOsmIds: [i + 1],
            axis: [ll(10, z), ll(60, z)], profile: { type: 'relative-peak', peakOffsetM: 2 },
            structureRange: { start: { distanceM: 15 }, end: { distanceM: 35 } } })),
    });
}
const addAlignment = model => model.setCenterlineTile('third', [{ properties: { osm_id: 3, highway: 'secondary', bridge: 'yes' },
    geometry: { type: 'LineString', coordinates: [ll(10, 30), ll(60, 30)] } }]);

test('reused alignment profiles retain their original samplers and both query/build consumers can outlive the model', () => {
    const f = fixture(), model = alignmentModel(f.terrain);
    const original = model.getAlignmentForOsmId(1);
    assert.ok(original); near(original.terrainSceneYAtLocal(10, 10), 2);
    f.replace((_x, z) => z > 70 ? 112 : 102);
    addAlignment(model);
    assert.ok(model.getAlignmentForOsmId(3));
    assert.equal(model.getAlignmentForOsmId(1), original);
    near(original.terrainSceneYAtLocal(10, 10), 2);
    assert.equal(f.terrain.usage().residentSnapshots, 2, 'reused and new alignments need different source owners');
    const before = f.terrain.usage().readSnapshots;
    let clock = 0;
    const partial = model.captureReadSnapshotSteps({ authoredPortalReplacements: [], now: () => clock += .3 });
    assert.equal(partial.next().done, false); partial.return();
    assert.equal(f.terrain.usage().readSnapshots, before);
    const read = drain(model.captureReadSnapshotSteps({ authoredPortalReplacements: [] }));
    const build = model.captureBuildInputs('structure-build');
    model.dispose();
    near(read.getAlignmentForOsmId(1).terrainSceneYAtLocal(10, 10), 2);
    read.release();
    near(build.alignments.find(row => row.id === original.id).terrainSceneYAtLocal(10, 10), 2);
    build.release();
    assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(f.terrain.usage().residentSnapshots, 1);
    assert.throws(() => original.terrainSceneYAtLocal(10, 10), { code: 'terrain-read-released' });
    f.retire(); f.terrain.close();
});

test('alignment cache admission failure frees the candidate and leaves the old analytic profile callable', () => {
    const f = fixture(2), model = alignmentModel(f.terrain);
    const original = model.getAlignmentForOsmId(1);
    const before = f.terrain.usage().readSnapshots;
    f.replace(107); model.invalidateTerrain();
    assert.throws(() => model.getAlignments(), { code: 'terrain-publication-capacity' });
    assert.equal(f.terrain.usage().readSnapshots, before);
    near(original.terrainSceneYAtLocal(10, 10), 2);
    model.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('prepared alignments reuse unaffected local profiles with real retained terrain generations', () => {
    const f = fixture(), model = alignmentModel(f.terrain);
    const original = model.getAlignmentForOsmId(1), active = model.getAlignments();
    f.replace(107); addAlignment(model);
    const candidate = drain(model.preparePublicationSteps({ authoredPortalReplacements: [] }));
    assert.equal(model.getAlignments(), active);
    assert.equal(model.getAlignmentForOsmId(3), null);
    assert.equal(candidate.read.getAlignmentForOsmId(1).points, original.points);
    near(candidate.read.getAlignmentForOsmId(1).terrainSceneYAtLocal(10, 10), 2);
    near(candidate.read.getAlignmentForOsmId(3).terrainSceneYAtLocal(10, 30), 7);
    const read = candidate.read.retain('dependent-build');
    assert.equal(candidate.isCurrent(), true); assert.equal(candidate.commit(), true);
    assert.equal(candidate.finalize(), true); model.dispose();
    near(read.getAlignmentForOsmId(1).terrainSceneYAtLocal(10, 10), 2);
    near(read.getAlignmentForOsmId(3).terrainSceneYAtLocal(10, 30), 7);
    read.release(); assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(f.terrain.usage().residentSnapshots, 1); f.retire(); f.terrain.close();
});

test('the actual curb preparation owner is released on stale cancellation after the road cache retires', () => {
    const f = fixture(), ground = drain(f.read());
    const curbs = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
    const runtime = vm.createContext({ retainReadSnapshot, FORMATION_DIRTY_PADDING_M: 32,
        captureSurfaceBuildGround: function* () { return ground.retain('curb-tile'); },
        terrainReference: { renderedRailSurface: null }, plannerTrackVolumeGrid: null, plannerTrackCorridorVolumes: [],
        tileLocalBounds: () => ({ minX: 0, minZ: 0, maxX: tileM, maxZ: tileM }),
        CURB_MASK_STAGES: [['masks:first', () => { throw new Error('stale preparation reached masks'); }]],
    });
    vm.runInContext(curbs.slice(curbs.indexOf('function createTilePrepTask('), curbs.indexOf('function currentRailCutEdgeEvaluator(')), runtime);
    const task = runtime.createTilePrepTask('0_0');
    assert.equal(task.step(), 'more');
    f.replace(107); ground.release(); f.retire();
    assert.ok(f.terrain.usage().readSnapshots > 0, 'curb preparation owns the old graph independently');
    assert.equal(task.step(), 'stale');
    task.dispose(); task.dispose();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('the production structure queue cancels stale work and releases captured inputs on cancellation and completion', async t => {
    const f = fixture(), model = alignmentModel(f.terrain);
    model.getAlignments();
    const idle = [], originalIdle = globalThis.requestIdleCallback, originalCancel = globalThis.cancelIdleCallback;
    globalThis.requestIdleCallback = callback => { idle.push(callback); return idle.length; };
    globalThis.cancelIdleCallback = () => {};
    setFrameChunkSchedulerMode('legacy');
    const queue = createFrameChunkQueue({ label: 'structure-lifetime-test', pauseDuringMovement: false, trackWorldReady: false });
    t.after(() => { queue.dispose(); model.dispose(); f.retire(); f.terrain.close();
        globalThis.requestIdleCallback = originalIdle; globalThis.cancelIdleCallback = originalCancel; });
    const observed = [], retired = [], roots = new Map();
    const runtime = vm.createContext({ alignmentModel: model, ensureSessionResources() {}, requestedRevision: -1,
        builtRevision: -1, buildGeneration: 0, buildJob: null, groundGenerationLease: null, buildQueue: queue, alignmentGroups: roots,
        materials: {}, structuralTramCorridorEnvelope: null, FRAME_CHUNK_REPEAT_ITEM,
        alignmentBounds: () => null, alignmentTaskPriority: () => 0,
        createAlignmentBuildTask(alignment) { let steps = 0; return { id: alignment.id, root: {}, step() {
            observed.push(alignment.terrainSceneYAtLocal(10, 10)); return ++steps === 2;
        } }; },
        replaceAlignmentGroup(task) { task.committed = true; roots.set(task.id, task.root); },
        disposeGroup: root => retired.push(root),
    });
    const structures = readFileSync(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8');
    vm.runInContext(structures.slice(structures.indexOf('function disposeUncommittedTasks('), structures.indexOf('function ensureSessionResources('))
        + structures.slice(structures.indexOf('function requestRebuild('), structures.indexOf('export const roadGradeSeparationsLayer')), runtime);
    const owners = f.terrain.usage().readSnapshots;
    runtime.requestRebuild(); const cancelled = runtime.buildJob;
    assert.ok(f.terrain.usage().readSnapshots > owners);
    idle.shift()({ timeRemaining: () => 100 });
    assert.ok(observed.length > 0); assert.equal(roots.size, 0);
    f.replace(107); model.invalidateTerrain();
    idle.shift()({ timeRemaining: () => 100 });
    assert.equal((await cancelled.promise).cancelled, true);
    assert.equal(roots.size, 0); assert.equal(retired.length, 2);
    assert.equal(f.terrain.usage().readSnapshots, owners);
    runtime.requestRebuild(); const completed = runtime.buildJob;
    for (let i = 0; idle.length && i < 20; i++) idle.shift()({ timeRemaining: () => 100 });
    assert.equal((await completed.promise).cancelled, false);
    assert.equal(roots.size, 2); near(observed.at(-1), 7);
    assert.equal(f.terrain.usage().readSnapshots, owners);
});

const railSource = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const railFeatures = [{ properties: { source: 'cb-proposal', proposalId: 'lease-fixture' },
    geometry: { type: 'LineString', coordinates: [ll(5, 20), ll(65, 20)] } }];
function railRuntime(f) {
    const runtime = vm.createContext({ lastTerrain: f.terrain, lastTerrainSource: f.terrain, lastRailFormation: null, lastStops: [],
        lastAnchorLat: lat, lastAnchorLon: lon, lastPhotoTrackFrame: null,
        RailFormationModel, captureGroundReadSnapshot, getRailFormationHalfWidthMeters: () => 4,
        getRenderedRailTrackbedHalfWidthAtSpacingMeters: () => 3,
        buildPlannerSurfaceCutStationAccessPlans: () => [], pendingRailFormationBuild: null,
        streamedRailInputRevision: 0, railFormationRevision: 0, streamedRailDirty: true,
        terrainRevisionDirty: false, terrainDirtyFullRefresh: false, terrainDirtyBounds: [],
        railStreamNowMs: () => 0, RAIL_FORMATION_MODEL_STEP_BUDGET_MS: 1, recordLayerFrameMs() {},
    });
    vm.runInContext(railSource.slice(railSource.indexOf('function createRailFormationModel('), railSource.indexOf('function installRailCivilGroundSnapshot('))
        + railSource.slice(railSource.indexOf('function replacePendingRailFormationBuild('), railSource.indexOf('function discardPendingRailVisualRefresh('))
        + railSource.slice(railSource.indexOf('function stepPendingRailFormationModel('), railSource.indexOf('export const railsLayer')), runtime);
    return runtime;
}

test('the production rail factory transfers its read owner and derived queries survive model retirement', () => {
    const f = fixture(), runtime = railRuntime(f);
    const model = runtime.createRailFormationModel(railFeatures);
    assert.equal(f.terrain.usage().readSnapshots, 1, 'the builder released its temporary capture');
    const partial = model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal });
    assert.equal(partial.next().done, false); partial.return();
    assert.equal(f.terrain.usage().readSnapshots, 1);
    const read = drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal }));
    const roadOwner = read.retain('road-rail-input');
    f.replace(107); model.dispose(); read.release();
    near(roadOwner.sceneYAtLocal(10, 70), 2);
    assert.equal(f.terrain.usage().residentSnapshots, 2);
    roadOwner.release();
    assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(f.terrain.usage().residentSnapshots, 1);
    assert.throws(() => roadOwner.sceneYAtLocal(10, 70), { code: 'terrain-read-released' });
    f.retire(); f.terrain.close();
});

test('rail cancellation, replacement and constructor/build failure release the real terrain owner', () => {
    const f = fixture(), runtime = railRuntime(f);
    const first = runtime.createRailFormationModel(railFeatures, { deferredBuild: true });
    first.stepPendingBuild();
    runtime.replacePendingRailFormationBuild({ model: first });
    const second = runtime.createRailFormationModel(railFeatures, { deferredBuild: true });
    runtime.replacePendingRailFormationBuild({ model: second });
    assert.equal(f.terrain.usage().readSnapshots, 1);
    assert.throws(() => first.stepPendingBuild(), /disposed/);
    runtime.discardPendingRailFormationBuild(); runtime.discardPendingRailFormationBuild();
    assert.equal(f.terrain.usage().readSnapshots, 0);
    runtime.buildPlannerSurfaceCutStationAccessPlans = () => { throw new Error('station compilation failed'); };
    assert.throws(() => runtime.createRailFormationModel(railFeatures), /station compilation failed/);
    assert.equal(f.terrain.usage().readSnapshots, 0);
    const failed = runtime.createRailFormationModel(railFeatures, { deferredBuild: true });
    assert.throws(() => { while (failed.hasPendingBuild()) failed.stepPendingBuild(); }, /station compilation failed/);
    assert.equal(f.terrain.usage().readSnapshots, 0);
    failed.dispose(); f.retire(); f.terrain.close();
});

test('the actual rail publisher stops old producers before retirement while keeping retained road inputs callable', () => {
    const f = fixture(), runtime = railRuntime(f);
    const old = runtime.createRailFormationModel(railFeatures);
    const read = drain(old.captureReadSnapshotSteps({ baseSceneYAtLocal: old.baseSceneYAtLocal }));
    runtime.lastRailFormation = old;
    f.replace(107);
    const next = runtime.createRailFormationModel(railFeatures);
    const cancelled = [];
    for (const name of ['discardPendingRailVisualRefresh', 'discardPendingRailStructuresRefresh',
        'discardPendingCrossingFormationRefresh', 'discardPendingEmbeddedTramMeshRefresh']) {
        runtime[name] = () => { near(old.baseSceneYAtLocal(10, 70), 2); cancelled.push(name); };
    }
    Object.assign(runtime, { streamedRailSessionContext: {}, railSessionToken: 0,
        publishedRailCivilGroundSnapshot: {}, publishedRailCivilGroundSnapshotModel: old,
        publishedRailCivilGroundSnapshotRevision: old.revision, publishedRailCivilGroundSnapshotMutation: 0,
        pendingPublishedRailCivilGroundSnapshot: null, pendingRailVisualRefresh: {},
        pendingRailStructuresRefresh: {}, pendingCrossingFormationRefresh: {},
        pendingEmbeddedTramMeshRefresh: {},
        ensurePillarClearanceForFormation() {}, recordLayerFrameMs() {} });
    vm.runInContext(railSource.slice(railSource.indexOf('function prepareRailFormationPublication('), railSource.indexOf('// terrainChangedBounds:')), runtime);
    runtime.publishRailFormation(next, railFeatures, { revisionPrepared: true, civilGroundSnapshot: {} });
    assert.equal(cancelled.length, 4);
    assert.equal(runtime.streamedRailSessionContext.railFormation, next);
    assert.throws(() => old.stepPendingBuild(), /disposed/);
    near(next.sceneYAtLocal(10, 70), 7); near(read.sceneYAtLocal(10, 70), 2);
    assert.equal(f.terrain.usage().readSnapshots, 2, 'only new model and retained old road input remain');
    read.release(); next.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('curb rail-cut indexes reuse shared profile data across retained handles and invalidate changed flags', () => {
    const f = fixture(), runtime = railRuntime(f), model = runtime.createRailFormationModel(railFeatures);
    const read = drain(model.captureReadSnapshotSteps({ baseSceneYAtLocal: model.baseSceneYAtLocal }));
    const second = read.retain('second-curb');
    let builds = 0;
    const curbs = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
    const cache = vm.createContext({ railCutEdgeEvaluatorKey: null, railCutEdgeEvaluator: () => false,
        RAIL_CUT_EDGE_PADDING_M: .25, createRailCutEdgeEvaluator(...args) { builds++; return createRailCutEdgeEvaluator(...args); } });
    vm.runInContext(curbs.slice(curbs.indexOf('function currentRailCutEdgeEvaluator('), curbs.indexOf('function prepareTileBuildContext(')), cache);
    const first = cache.currentRailCutEdgeEvaluator(read);
    assert.equal(cache.currentRailCutEdgeEvaluator(second), first);
    assert.equal(builds, 1, 'a new owner must not rebuild an unchanged geometry index');
    const a = { x: 10, z: 70 }, b = { x: 30, z: 70 };
    assert.equal(first(a, b), createRailCutEdgeEvaluator(read, .25)(a, b));
    const live = cache.currentRailCutEdgeEvaluator(model);
    model.civilGroundMutationRevision = 1;
    assert.notEqual(cache.currentRailCutEdgeEvaluator(model), live, 'same-instance flags invalidate the index');
    second.release(); read.release(); model.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('a failed rail build preserves old queries and its rebuild bounds without an every-frame retry loop', () => {
    const f = fixture(), runtime = railRuntime(f), old = runtime.createRailFormationModel(railFeatures);
    runtime.lastRailFormation = old;
    f.replace(107);
    let attempts = 0;
    runtime.buildPlannerSurfaceCutStationAccessPlans = () => { attempts++; throw new Error('bad station input'); };
    const bounds = { minX: 0, maxX: 70, minZ: 0, maxZ: 40 };
    runtime.createPendingRailFormationBuild(railFeatures, { fullRefresh: false, changeBounds: [bounds] });
    assert.throws(() => runtime.stepPendingRailFormationModel(), /bad station input/);
    const failed = runtime.pendingRailFormationBuild;
    assert.equal(failed.failure.message, 'bad station input'); assert.equal(failed.model, null);
    f.terrain.captureReadSnapshot('unrelated-reader').release();
    for (let i = 0; i < 60; i++) assert.equal(runtime.stepPendingRailFormationModel(), false);
    assert.equal(attempts, 1); assert.equal(runtime.lastRailFormation, old);
    near(old.sceneYAtLocal(10, 70), 2);
    assert.equal(f.terrain.usage().readSnapshots, 1, 'only old active rail remains');
    runtime.buildPlannerSurfaceCutStationAccessPlans = () => [];
    f.replace(108);
    assert.equal(runtime.stepPendingRailFormationModel(), false);
    assert.equal(runtime.pendingRailFormationBuild, null);
    assert.equal(runtime.terrainRevisionDirty, true); assert.deepEqual(Array.from(runtime.terrainDirtyBounds), [bounds]);
    const retry = runtime.createPendingRailFormationBuild(railFeatures, { fullRefresh: false, changeBounds: runtime.terrainDirtyBounds });
    assert.equal(runtime.stepPendingRailFormationModel(), true); assert.equal(retry.modelBuilt, true);
    near(retry.model.sceneYAtLocal(10, 70), 8); near(old.sceneYAtLocal(10, 70), 2);
    runtime.discardPendingRailFormationBuild(); old.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('rail capture admission failure waits for another owner to release capacity before retrying', () => {
    const f = fixture(2), runtime = railRuntime(f);
    const a = f.terrain.captureReadSnapshot('first-holder'), b = a.retain('second-holder');
    const fields = { fullRefresh: true, changeBounds: [] };
    assert.throws(() => runtime.createPendingRailFormationBuild(railFeatures, fields), { code: 'terrain-publication-capacity' });
    assert.equal(runtime.pendingRailFormationBuild.failure.code, 'terrain-publication-capacity');
    const failed = runtime.pendingRailFormationBuild;
    for (let i = 0; i < 60; i++) assert.equal(runtime.stepPendingRailFormationModel(), false);
    assert.equal(runtime.pendingRailFormationBuild, failed);
    a.release(); b.release();
    assert.equal(runtime.stepPendingRailFormationModel(), false);
    assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(runtime.pendingRailFormationBuild, null); assert.equal(runtime.terrainDirtyFullRefresh, true);
    const retry = runtime.createPendingRailFormationBuild(railFeatures, fields);
    assert.equal(runtime.stepPendingRailFormationModel(), true); assert.equal(retry.modelBuilt, true);
    runtime.discardPendingRailFormationBuild(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

// Run the actual deferred visual pipeline with real retained source queries.
// Geometry emission and GPU upload are orchestration spies, not GPU evidence.
function railVisualRuntime(f) {
    const retired = [], phases = [], active = new THREE.Group();
    const refresh = { centerX: 20, centerZ: 20, reason: 'streamed', streamedSignature: 'old-source', streamedInputRevision: 4 };
    let maskRevision = 0;
    const context = vm.createContext({
        THREE, ownReadSnapshot, railSessionToken: 1, lastFeatures: [], lastTerrain: f.terrain,
        lastRailFormation: null, lastRoadFormation: f.model, lastRoadVerticalAlignments: null,
        lastPillarClearance: null, pillarClearanceReady: false, mappedSeaStructuresRevision: 0,
        photoStationStructureRevision: 0, lastBridgeStyleLocationId: 'zagreb', lastBridgeStyleCityId: 'zagreb',
        lastAnchorLat: lat, lastAnchorLon: lon, lastStops: [], lastPhotoTrackFrame: null,
        lastRampOpenCutVolumes: [], lastMaxRadiusM: 80, RAIL_WALL_WINDOW_PADDING_M: 10,
        isPhotoWorld: () => false, performance, railStreamNowMs: () => 0, recordLayerFrameMs() {},
        renderedRailSegmentOwnsCivilGround: () => true,
        captureProposalMaskSnapshot() { const revision = maskRevision; return {
            isCurrent: () => revision === maskRevision, isLineStringMasked: () => false,
        }; },
        streamedRailSessionContext: { captureSurfaceBuildGround: () => f.read() },
        pendingRailVisualRefresh: refresh, railStructuresGroup: null, railStructuresKey: null,
        enqueueRailRetirement: root => retired.push(root), cancelRailGpuUploadStage() {},
        enqueueRailDressingPreparation: (refresh, target, options = {}) => {
            if (refresh.dressingBuildJob || refresh[options.readyProperty]) return;
            refresh.dressingBuild = (function* () {
                yield* context.addRailFormationTerrainCollarsSteps(target, refresh.ground.railFormation);
                yield* context.addRailFormationRetainingWallsSteps(target, refresh.ground.railFormation);
                refresh[options.readyProperty] = true;
            })();
            refresh.dressingBuildJob = { cancel() { refresh.dressingBuild?.return?.(); refresh.dressingBuild = null; refresh.dressingBuildJob = null; } };
        },
        cancelRailDressingPreparation: refresh => {
            if (!refresh) return;
            refresh.dressingBuild?.return?.(); refresh.dressingBuild = null; refresh.dressingBuildJob = null;
        },
        buildUndergroundStationFlareProfiles: () => [],
        *computeRailTrackbedSegmentsResumable(features, anchorLat, anchorLon, radius, inputs) {
            phases.push(['segments', inputs]); yield { phase: 'sample' };
            return [{ yStart: inputs.terrain?.sceneYAtLocal(10, 10) ?? 0 }];
        },
        addRailFormationTerrainCollarsSteps: function* (root, rail) { phases.push(['collars', rail]); yield { phase: 'collars' }; },
        addRailFormationRetainingWallsSteps: function* (root, rail) { phases.push(['walls', rail]); yield { phase: 'walls' }; },
        railPillarRoadSurfaceSignature: () => 'pillar-input', railStructuresBuildKey: () => 'structures-key',
        createRailStructuresGroup: (rail, terrain, flares, x, z, radius, phase, road, mappedWater) => {
            phases.push(['structures', { rail, terrain, road, mappedWater }]); return new THREE.Group();
        },
        createRailGpuPrewarm: () => (function* () {})(),
        enqueueRailGpuUploadStage: (refresh, options) => { refresh[options.readyProperty] = true; },
        ensureRailCellQueue: () => ({ enqueue: (_items, _step) => {
            const job = { cancel() {} };
            context.pendingRailVisualRefresh.publicationComplete = true;
            return job;
        } }),
        enqueueRailPublicationPreparation: refresh => { refresh.publicationComplete = true; },
        prepareVisibleRails: (x, z, options) => {
            phases.push(['candidate', options.ground]); return { root: new THREE.Group() };
        },
    });
    vm.runInContext(railSource.slice(railSource.indexOf('function discardPendingRailVisualRefresh('),
        railSource.indexOf('function discardPendingRailStructuresRefresh(')), context);
    return { context, refresh, retired, phases, active,
        changeMask: () => maskRevision++,
        step: () => { advanceDressingStub(context.pendingRailVisualRefresh); return context.stepPendingRailVisualPreparation(); },
        until(predicate) { for (let i = 0; i < 10000; i++) { this.step(); if (predicate()) return; }
            assert.fail('rail preparation did not reach its expected stage'); },
    };
}

test('admitted rail generation shares the ordinary visual stages and releases real terrain owners on every outcome', () => {
    for (const outcome of ['cancel', 'source-change', 'missing', 'false', 'rollback', 'published']) {
        const f = fixture(), r = railVisualRuntime(f), c = r.context, registry = createSurfacePublicationRegistry();
        const geometry = new THREE.PlaneGeometry(2, 2), material = new THREE.MeshBasicMaterial();
        Object.assign(c, { retainReadSnapshot, group: r.active, railGroundGenerationLease: null, groundManaged: false,
            pendingRailVisualRefresh: null, pendingRailFormationBuild: null, pendingRailStructuresRefresh: null,
            pendingCrossingFormationRefresh: null, pendingEmbeddedTramMeshRefresh: null,
            streamedRailInputRevision: 0, sampledTrackbedRevision: 0, renderedRailSurfaceRevision: 0 });
        c.enqueueRailRetirement = root => { root.removeFromParent(); r.retired.push(root); };
        const read = drain(f.read()), proposalMask = Object.freeze({ isCurrent: () => true });
        const mappedWater = Object.freeze({ signature: 'private-coast-2', sceneY: -10, contains: () => true });
        const ground = ownReadSnapshot({ ...read, proposalMask, roadSupportCacheSource: f.model, mappedWater }, [read]);
        const baselineOwners = f.terrain.usage().readSnapshots;
        let refresh = null, active = 'old', candidate = null;
        const dressing = c.enqueueRailDressingPreparation;
        c.enqueueRailDressingPreparation = (...args) => { refresh = args[0]; return dressing(...args); };
        c.enqueueRailPublicationPreparation = () => { throw new Error('private rail generation published independently'); };
        c.streamedRailSessionContext.captureSurfaceBuildGround = () => { throw new Error('private rail generation captured live ground'); };
        // The separate GTA test exercises the real geometry/publication adapter.
        // Here a reversible registry entry isolates the complete-stage owner.
        c.prepareRailCandidatePublicationSteps = function* (visual, options) {
            if (outcome === 'false') return false;
            assert.equal(options.preparePhysics, false);
            assert.equal(options.features, c.lastFeatures);
            assert.equal(options.ground.roadSupportCacheSource, f.model);
            assert.equal(options.ground.proposalMask, proposalMask);
            assert.equal(options.ground.mappedWater, mappedWater);
            assert.equal(r.phases.find(([name]) => name === 'structures')[1].mappedWater, mappedWater,
                'viaduct structures receive this generation of coastal data');
            near(y(options.ground.terrain), 2);
            yield { phase: 'controlled-complete-receiver' };
            const mesh = new THREE.Mesh(geometry, material);
            markSurfaceClaim(mesh, { surfaceClass: SURFACE_CLASS.RAIL_TRACKBED }); visual.root.add(mesh);
            let committed = false, discarded = false;
            const ticket = registry.begin({ key: 'rail:controlled-receiver', generation: 1, parent: r.active });
            const entry = { ticket, root: visual.root, isCurrent: () => !discarded && options.isCurrent(),
                commit() { active = 'next'; committed = true; return true; },
                rollback() { active = 'old'; committed = false; },
                discard() { discarded = true; } };
            return { entries: [entry], isCurrent: entry.isCurrent, discard: entry.discard,
                finalize() { if (!committed) return false; visual.committed = true; return true; } };
        };
        if (outcome === 'missing') c.prepareVisibleRails = () => null;
        const admission = drain(c.admitRailGroundGenerationSteps({ isCurrent: () => true, maxFeatures: 4 }));
        assert.ok(admission);
        const steps = c.prepareRailGroundGenerationSteps({ admission, ground, centerX: 20, centerZ: 20,
            isCurrent: () => true, maxSegments: 8, maxCells: 8 });
        try {
            let done = false;
            for (let i = 0; i < 1000 && !done; i++) {
                advanceDressingStub(refresh);
                let next;
                try { next = steps.next(); }
                catch (error) {
                    assert.equal(outcome, 'missing'); assert.equal(error.code, 'rail-receiver-evidence-unavailable');
                    done = true; break;
                }
                assert.equal(active, 'old'); assert.equal(r.active.children.length, 0);
                if (outcome === 'cancel') { c.railGroundGenerationLease.cancel(); steps.return(); done = true; break; }
                if (outcome === 'source-change' && i === 0) c.streamedRailInputRevision++;
                if (next.done) { candidate = next.value; done = true; }
            }
            assert.equal(done, true, 'private visual preparation must converge');
            if (['rollback', 'published'].includes(outcome)) {
                assert.ok(candidate); assert.ok(f.terrain.usage().readSnapshots > baselineOwners);
                const batch = registry.prepareBatch(candidate.entries, { commit() {
                    if (outcome === 'rollback') throw new Error('later terrain receiver failed');
                } });
                if (outcome === 'rollback') {
                    assert.throws(() => batch.publish(), /later terrain receiver failed/);
                    assert.equal(active, 'old'); assert.equal(r.active.children.length, 0);
                } else {
                    assert.equal(batch.publish().status, 'published'); assert.equal(candidate.finalize(), true);
                    assert.equal(active, 'next'); assert.equal(r.active.children.length, 1);
                    assert.equal(r.retired.includes(r.active.children[0]), false, 'finalization keeps the published receiver');
                }
                assert.equal(candidate.isCurrent(), false);
            } else assert.equal(candidate, null);
            assert.equal(c.railGroundGenerationLease, null);
            assert.equal(f.terrain.usage().readSnapshots, baselineOwners);
        } finally {
            steps.return(); candidate?.discard(); c.railGroundGenerationLease?.cancel();
            registry.close({ retireActive: true }); ground.release(); f.retire();
            assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close(); geometry.dispose(); material.dispose();
        }
    }
});

test('the actual rail visual capture keeps all ground owners through cancellation and preserves its replacement obligation', () => {
    const f = fixture(), r = railVisualRuntime(f);
    const model = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(model); r.context.lastRailFormation = model;
    r.until(() => r.refresh.ground);
    const old = r.refresh.ground;
    near(y(old.terrain), 2);
    assert.ok(old.railFormation.getSurfaceProfiles().length > 0);
    f.replace(108); f.retire(); model.dispose();
    near(y(old.terrain), 2);
    assert.equal(f.terrain.usage().residentSnapshots, 2);
    assert.equal(r.step(), false);
    assert.notEqual(r.context.pendingRailVisualRefresh, r.refresh);
    assert.equal(r.context.pendingRailVisualRefresh.streamedSignature, 'old-source');
    assert.equal(r.context.pendingRailVisualRefresh.streamedInputRevision, 4);
    assert.equal(f.terrain.usage().residentSnapshots, 1);
    assert.throws(() => y(old.terrain), { code: 'terrain-read-released' });
});

test('every actual visual preparation stage receives one shared ground and a late proposal edit rejects its uploaded candidate', () => {
    const f = fixture(), r = railVisualRuntime(f);
    r.until(() => r.step());
    const ground = r.refresh.ground;
    const get = name => r.phases.find(entry => entry[0] === name)?.[1];
    assert.equal(get('segments').terrain, ground.terrain);
    assert.equal(get('segments').roadFormation, ground.roadFormation);
    assert.equal(get('segments').roadSupportCacheSource, f.model);
    assert.equal(get('segments').proposalMask, ground.proposalMask);
    assert.equal(get('collars'), ground.railFormation);
    assert.equal(get('walls'), ground.railFormation);
    assert.equal(get('structures').terrain, ground.terrain);
    assert.equal(get('structures').road, ground.roadFormation);
    assert.equal(get('candidate'), ground);
    const candidate = r.refresh.candidate.root;
    r.changeMask();
    assert.equal(r.step(), false);
    assert.deepEqual(r.retired, [candidate]);
    assert.equal(r.active.children.length, 0, 'preparation never attached a replacement');
    assert.equal(r.context.pendingRailVisualRefresh.reason, 'streamed');
    f.retire(); r.context.discardPendingRailVisualRefresh();
    assert.equal(f.terrain.usage().readSnapshots, 0);
});

test('a rail visual exception releases partial dressing and waits for changed inputs before retrying', () => {
    const f = fixture(), r = railVisualRuntime(f);
    let calls = 0;
    r.context.addRailFormationRetainingWallsSteps = function* () { calls++; throw new Error('bad-rail-wall'); };
    assert.throws(() => r.until(() => false), /bad-rail-wall/);
    assert.equal(calls, 1); assert.equal(r.retired.length, 1);
    assert.equal(r.retired[0].name, 'RailFormationDressing');
    assert.equal(r.context.pendingRailVisualRefresh.failure.message, 'bad-rail-wall');
    for (let i = 0; i < 60; i++) assert.equal(r.step(), false);
    assert.equal(calls, 1);
    f.replace(108);
    assert.equal(r.step(), false);
    assert.equal(r.context.pendingRailVisualRefresh.failure, undefined);
    r.context.addRailFormationRetainingWallsSteps = function* () { calls++; yield { phase: 'walls' }; };
    r.until(() => r.step());
    near(y(r.context.pendingRailVisualRefresh.ground.terrain), 8);
    assert.equal(calls, 2);
    r.context.discardPendingRailVisualRefresh(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0);
});

test('cancelling the actual rail visual during cooperative shared capture frees its unfinished owner', () => {
    const f = fixture(), r = railVisualRuntime(f);
    assert.equal(r.step(), false);
    assert.ok(r.refresh.groundBuild);
    f.replace(108);
    r.context.discardPendingRailVisualRefresh(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0);
    assert.equal(f.terrain.usage().residentSnapshots, 1);
});

test('rail visual capacity admission retries only after a different owner releases capacity', () => {
    const f = fixture(24), r = railVisualRuntime(f);
    const warmed = drain(f.read()); warmed.release();
    const otherOwners = [];
    try { for (;;) otherOwners.push(f.terrain.captureReadSnapshot('other-job')); }
    catch (error) { assert.equal(error.code, 'terrain-publication-capacity'); }
    assert.throws(() => r.step(), { code: 'terrain-publication-capacity' });
    const failed = r.context.pendingRailVisualRefresh;
    for (let i = 0; i < 60; i++) assert.equal(r.step(), false);
    assert.equal(r.context.pendingRailVisualRefresh, failed);
    otherOwners.pop().release(); otherOwners.pop().release();
    assert.equal(r.step(), false); assert.notEqual(r.context.pendingRailVisualRefresh, failed);
    r.until(() => r.context.pendingRailVisualRefresh.ground);
    r.context.discardPendingRailVisualRefresh(); f.retire();
    for (const owner of otherOwners) owner.release();
    assert.equal(f.terrain.usage().readSnapshots, 0);
});

// Isolated production structures refresh with the same retained-ground capture.
function finishRailLifetime(f, model) {
    model?.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0, 'no source owner is hidden by forced provider close');
    f.terrain.close();
}

function advanceUntil(step, ready) {
    for (let i = 0; i < 10000 && !ready(); i++) step();
    assert.ok(ready(), 'deferred preparation must reach the requested state');
}

function railStructuresRuntime(f) {
    const r = railVisualRuntime(f);
    const { context } = r;
    Object.assign(context, {
        group: r.active, pendingRailStructuresRefresh: null,
        lastStationFlares: [], lastRenderCenterX: 20, lastRenderCenterZ: 20,
        lastMaxRadiusM: 80, lastRailPillarRoadSignature: 'pillar-input',
        lastPhotoTrackFrame: null, lastAnchorLat: lat, lastAnchorLon: lon,
        railStructuresBuildKey: () => 'structures-key',
        addRailViaducts: (root, rail, terrain, x, z, radius, road) => r.phases.push(['viaducts', { root, rail, terrain, road }]),
        addRailTunnels: (root, rail) => r.phases.push(['tunnels', rail]),
        annotateRailInspectionLayers() {},
        railStructuresRefreshIsCurrent: null,
        scheduleRailStructuresRefresh: null,
        pendingRailStructuresRefresh: null,
    });
    const discardStructuresSource = railSource.slice(railSource.indexOf('function discardPendingRailStructuresRefresh('),
        railSource.indexOf('function discardPendingCrossingFormationRefresh('));
    const structuresSource = railSource.slice(railSource.indexOf('function scheduleRailStructuresRefresh('),
        railSource.indexOf('function scheduleRailStructuresForRoadSurface('));
    vm.runInContext(discardStructuresSource + '\n' + structuresSource, context);
    return {
        ...r,
        schedule: reason => context.scheduleRailStructuresRefresh(reason),
        stepStructures: () => context.stepPendingRailStructuresRefresh(),
        discardStructures: () => context.discardPendingRailStructuresRefresh(),
    };
}

test('standalone rail structures retain shared captured ground and release it on cancellation', () => {
    const f = fixture(), r = railStructuresRuntime(f);
    r.context.lastRailFormation = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(r.context.lastRailFormation);
    r.schedule('pillarRoad');
    const before = f.terrain.usage().readSnapshots;
    assert.equal(r.stepStructures(), true);
    assert.ok(r.context.pendingRailStructuresRefresh.groundBuild);
    assert.ok(f.terrain.usage().readSnapshots > before);
    r.discardStructures();
    assert.equal(r.context.pendingRailStructuresRefresh, null);
    r.context.lastRailFormation.dispose(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0); f.terrain.close();
});

test('rail structures use one captured ground for viaducts and publish after GPU readiness', () => {
    const f = fixture(), r = railStructuresRuntime(f);
    r.context.lastRailFormation = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(r.context.lastRailFormation);
    let uploadRefresh = null;
    const previous = new THREE.Group(); r.active.add(previous);
    r.context.railStructuresGroup = previous;
    r.context.enqueueRailGpuUploadStage = refresh => { uploadRefresh = refresh; };
    r.schedule('pillarRoad');
    for (let i = 0; i < 10000 && !uploadRefresh; i++) r.stepStructures();
    assert.ok(uploadRefresh);
    assert.deepEqual(r.active.children, [previous]);
    const ground = uploadRefresh.ground, replacement = uploadRefresh.structuresGroup;
    for (let i = 0; i < 3; i++) r.stepStructures();
    assert.equal(previous.parent, r.active); assert.equal(replacement.parent, null);
    uploadRefresh.gpuReady = true;
    while (r.context.pendingRailStructuresRefresh) r.stepStructures();
    const viaduct = r.phases.find(entry => entry[0] === 'viaducts')?.[1];
    assert.ok(viaduct);
    assert.ok(viaduct.rail); assert.equal(viaduct.rail, ground.railFormation);
    assert.notEqual(viaduct.rail, r.context.lastRailFormation);
    assert.equal(r.phases.find(entry => entry[0] === 'tunnels')[1], viaduct.rail);
    assert.equal(viaduct.terrain.contract, 'station3d-ground-read-snapshot-v1');
    assert.equal(viaduct.road.contract, 'station3d-road-formation-read-snapshot-v1');
    near(y(viaduct.terrain), 2); near(y(viaduct.road), 2);
    assert.equal(r.context.pendingRailStructuresRefresh, null);
    assert.equal(r.active.children.length, 1);
    assert.equal(r.active.children[0], replacement); assert.equal(previous.parent, null);
    assert.ok(r.retired.includes(previous));
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    finishRailLifetime(f, r.context.lastRailFormation);
});

test('stale rail structures restart with a fresh captured ground and release the old candidate', () => {
    const f = fixture(), r = railStructuresRuntime(f);
    r.context.lastRailFormation = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(r.context.lastRailFormation);
    r.schedule('pillarRoad');
    r.stepStructures();
    const first = r.context.pendingRailStructuresRefresh;
    f.replace(108);
    assert.equal(r.stepStructures(), true);
    assert.notEqual(r.context.pendingRailStructuresRefresh, first);
    assert.equal(first.ground, null);
    r.discardStructures(); r.context.lastRailFormation.dispose(); f.retire(); f.terrain.close();
});

test('rail structures preparation records an error and does not retry every frame', () => {
    const f = fixture(), r = railStructuresRuntime(f);
    r.context.lastRailFormation = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(r.context.lastRailFormation);
    let calls = 0;
    r.context.addRailViaducts = () => { calls++; throw new Error('bad-viaduct'); };
    r.schedule('pillarRoad');
    for (let i = 0; i < 10000 && !r.context.pendingRailStructuresRefresh?.failure; i++) {
        try { r.stepStructures(); } catch (error) { assert.match(error.message, /bad-viaduct/); }
    }
    assert.equal(calls, 1);
    assert.equal(r.context.pendingRailStructuresRefresh.failure.message, 'bad-viaduct');
    for (let i = 0; i < 20; i++) assert.equal(r.stepStructures(), false);
    assert.equal(calls, 1);
    assert.equal(r.context.pendingRailStructuresRefresh.ground, null);
    assert.equal(r.context.pendingRailStructuresRefresh.structuresGroup, null);
    r.discardStructures(); finishRailLifetime(f, r.context.lastRailFormation);
});

test('real rail GPU upload callback records failure and blocks repeated visual visits', async t => {
    const f = fixture(), r = railVisualRuntime(f), idle = [];
    const originalIdle = globalThis.requestIdleCallback;
    const originalCancel = globalThis.cancelIdleCallback;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.requestIdleCallback = callback => { idle.push(callback); return idle.length; };
    globalThis.cancelIdleCallback = () => {};
    globalThis.setTimeout = callback => { idle.push(() => callback()); return idle.length; };
    globalThis.clearTimeout = () => {};
    setFrameChunkSchedulerMode('legacy');
    t.after(() => {
        globalThis.requestIdleCallback = originalIdle;
        globalThis.cancelIdleCallback = originalCancel;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        f.retire(); f.terrain.close();
    });
    r.until(() => r.refresh.ground);
    const ground = r.refresh.ground;
    Object.assign(r.context, {
        railGpuUploadQueue: null, createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM,
        stepRailGpuPrewarm(iterator) { return iterator.next(); },
        cancelRailGpuPrewarm(iterator) { iterator?.return?.(); },
    });
    const enqueueSource = railSource.slice(
        railSource.indexOf('function cancelRailGpuPrewarm('),
        railSource.indexOf('function ensureRailRetirementQueue('),
    ) + railSource.slice(
        railSource.indexOf('function enqueueRailGpuUploadStage('),
        railSource.indexOf('function ensureRailCellQueue('),
    );
    vm.runInContext(enqueueSource, r.context);
    let closed = false;
    r.refresh.upload = (function* () {
        try { yield { phase: 'upload' }; throw new Error('upload-failed'); }
        finally { closed = true; }
    })();
    r.context.enqueueRailGpuUploadStage(r.refresh, {
        iteratorProperty: 'upload', jobProperty: 'uploadJob', readyProperty: 'gpuReady',
        failedProperty: 'uploadFailed', label: 'test-upload',
    });
    // The queue callback owns the iterator; drive its actual deferred callback.
    idle.shift()({ timeRemaining: () => 100 });
    idle.shift()({ timeRemaining: () => 100 });
    assert.equal(r.refresh.uploadError?.message, 'upload-failed');
    assert.equal(closed, true);
    const calls = r.refresh.uploadJob;
    assert.equal(calls, null);
    assert.throws(() => r.step(), /upload-failed/);
    assert.equal(r.refresh.uploadError?.message, 'upload-failed');
    assert.equal(r.refresh.uploadJob, null);
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    const failed = r.context.pendingRailVisualRefresh;
    for (let i = 0; i < 60; i++) assert.equal(r.step(), false);
    assert.equal(r.context.pendingRailVisualRefresh, failed);
    f.replace(108);
    assert.equal(r.step(), false);
    assert.notEqual(r.context.pendingRailVisualRefresh, failed);
    r.until(() => r.context.pendingRailVisualRefresh.ground);
    near(y(r.context.pendingRailVisualRefresh.ground.roadFormation), 8);
    r.context.discardPendingRailVisualRefresh(); f.retire();
    assert.equal(f.terrain.usage().readSnapshots, 0);
});

// The production queue adapter has its own behavioral test. These ownership
// fixtures advance one controlled CPU callback before the next world visit.
function advanceDressingStub(refresh) {
    if (!refresh?.dressingBuild) return;
    try {
        if (!refresh.dressingBuild.next().done) return;
    } catch (error) { refresh.dressingError = error; }
    refresh.dressingBuild = null;
    refresh.dressingBuildJob = null;
}

function railCrossingRuntime(f) {
    const r = railVisualRuntime(f), model = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(model); r.context.lastRailFormation = model;
    const dressing = new THREE.Group(); dressing.name = 'RailFormationDressing'; r.active.add(dressing);
    const old = ['RailFormationTerrainCollar', 'RailFormationRetainingWalls', 'RailFormationRetainingWalls:2']
        .map(name => { const node = new THREE.Group(); node.name = name; dressing.add(node); return node; });
    const keep = new THREE.Group(); keep.name = 'unrelated-dressing'; dressing.add(keep);
    const emit = (root, rail, name, phase) => {
        r.phases.push([phase, rail]); const node = new THREE.Group(); node.name = name; root.add(node);
    };
    Object.assign(r.context, {
        group: r.active, pendingCrossingFormationRefresh: null,
        lastTerrain: f.terrain, lastMaxRadiusM: 80,
        performance, finiteOrNull: value => typeof value === 'number' && Number.isFinite(value) ? value : null,
        disposeGroup: root => root?.clear?.(),
        addRailFormationTerrainCollarsSteps: function* (root, rail) { emit(root, rail, 'RailFormationTerrainCollar', 'cross-collar'); yield { phase: 'collars' }; },
        addRailFormationRetainingWallsSteps: function* (root, rail) { emit(root, rail, 'RailFormationRetainingWalls', 'cross-wall'); yield { phase: 'retainingWalls' }; },
        createRailGpuPrewarm: () => (function* () {})(),
        enqueueRailGpuUploadStage: refresh => { refresh.gpuReady = true; },
    });
    const discard = railSource.slice(railSource.indexOf('function discardPendingCrossingFormationRefresh('),
        railSource.indexOf('function buildUndergroundStationFlareProfiles('));
    const crossing = railSource.slice(railSource.indexOf('function rebuildCrossingSuppressedFormationMeshes('),
        railSource.indexOf('export function getRailsGroupForWalkColliders('));
    vm.runInContext(discard + '\n' + crossing, r.context);
    let queuedPublication = null;
    r.context.railBoundaryInputs = () => ({ rail: model });
    r.context.prepareRailBoundaryGroundSteps = refresh => r.context.captureRailVisualGroundSteps(refresh, 'crossing-lifetime-fixture');
    r.context.enqueueRailBoundaryPublication = refresh => {
        if (refresh.candidate) return;
        refresh.candidate = { committed: false };
        queuedPublication = () => {
            for (const node of old) node.removeFromParent();
            for (const node of [...refresh.replacement.children]) dressing.add(node);
            refresh.candidate.committed = true;
        };
    };

    return { ...r, model, dressing, old, keep,
        schedule: () => r.context.rebuildCrossingSuppressedFormationMeshes(20, 20),
        stepCrossing: () => { const publish = queuedPublication; queuedPublication = null; publish?.(); advanceDressingStub(r.context.pendingCrossingFormationRefresh); return r.context.stepCrossingSuppressedFormationMeshes(); },
        discardCrossing: () => r.context.discardPendingCrossingFormationRefresh(),
    };
}

test('crossing preparation shares one captured rail through collar and wall stages', () => {
    const f = fixture(), r = railCrossingRuntime(f);
    r.schedule();
    for (let i = 0; i < 10000 && r.context.pendingCrossingFormationRefresh; i++) r.stepCrossing();
    const rails = r.phases.filter(entry => entry[0] === 'cross-collar' || entry[0] === 'cross-wall').map(entry => entry[1]);
    assert.equal(rails.length, 2); assert.ok(rails[0]); assert.equal(rails[0], rails[1]);
    assert.notEqual(rails[0], r.model);
    assert.equal(r.context.pendingCrossingFormationRefresh, null);
    finishRailLifetime(f, r.model);
});

test('crossing GPU readiness gates replacement until the upload callback completes', () => {
    const f = fixture(), r = railCrossingRuntime(f); let upload = null;
    r.context.enqueueRailGpuUploadStage = refresh => { upload = refresh; };
    r.schedule();
    for (let i = 0; i < 10000 && !upload; i++) r.stepCrossing();
    assert.ok(upload); assert.deepEqual(r.dressing.children, [...r.old, r.keep]);
    const ground = upload.ground;
    for (let i = 0; i < 3; i++) r.stepCrossing();
    assert.deepEqual(r.dressing.children, [...r.old, r.keep]);
    upload.gpuReady = true; while (r.context.pendingCrossingFormationRefresh) r.stepCrossing();
    assert.equal(r.keep.parent, r.dressing);
    for (const old of r.old) assert.equal(old.parent, null);
    assert.equal(r.dressing.children.length, 3);
    assert.ok(r.dressing.children.some(child => child.name === 'RailFormationTerrainCollar'));
    assert.ok(r.dressing.children.some(child => child.name === 'RailFormationRetainingWalls'));
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    assert.equal(r.context.pendingCrossingFormationRefresh, null);
    finishRailLifetime(f, r.model);
});

test('stale crossing preparation is cancelled and failed crossing work does not retry every frame', () => {
    const f = fixture(), r = railCrossingRuntime(f);
    r.schedule();
    advanceUntil(r.stepCrossing, () => r.context.pendingCrossingFormationRefresh.ground);
    r.stepCrossing();
    const stale = r.context.pendingCrossingFormationRefresh, staleGround = stale.ground, staleRoot = stale.replacement;
    f.replace(108);
    assert.equal(r.stepCrossing(), true);
    assert.notEqual(r.context.pendingCrossingFormationRefresh, stale);
    assert.ok(r.retired.includes(staleRoot));
    assert.throws(() => staleGround.retain('late'), { code: 'read-snapshot-released' });
    assert.deepEqual(r.dressing.children, [...r.old, r.keep]);
    r.discardCrossing();
    const buildCollar = r.context.addRailFormationTerrainCollarsSteps;
    let calls = 0; r.context.addRailFormationTerrainCollarsSteps = function* () { calls++; throw new Error('cross-failure'); };
    r.schedule();
    for (let i = 0; i < 10000 && !r.context.pendingCrossingFormationRefresh?.failure; i++) {
        try { r.stepCrossing(); } catch (error) { assert.match(error.message, /cross-failure/); }
    }
    assert.equal(calls, 1);
    for (let i = 0; i < 60; i++) assert.equal(r.stepCrossing(), false);
    assert.equal(calls, 1);
    const failed = r.context.pendingCrossingFormationRefresh;
    assert.equal(failed.ground, null); assert.equal(failed.replacement, null);
    f.replace(109); r.context.addRailFormationTerrainCollarsSteps = buildCollar;
    r.stepCrossing(); assert.notEqual(r.context.pendingCrossingFormationRefresh, failed);
    advanceUntil(r.stepCrossing, () => !r.context.pendingCrossingFormationRefresh);
    finishRailLifetime(f, r.model);
});

function embeddedTramRuntime(f) {
    const r = railVisualRuntime(f), model = railRuntime(f).createRailFormationModel(railFeatures);
    f.setRail(model); r.context.lastRailFormation = model;
    const tram = [{ sortKey: 'tram-1', railway_type: 'tram', yStart: 1, yEnd: 1 }];
    Object.assign(r.context, {
        group: r.active, performance, EMBEDDED_TRAM_MAX_LATERAL_M: 20,
        finiteOrNull: value => typeof value === 'number' && Number.isFinite(value) ? value : null,
        lastFeatures: [{ properties: { railway: 'tram' }, geometry: { type: 'LineString', coordinates: [ll(5, 20), ll(65, 20)] } }],
        lastRoadFormation: f.model, lastTerrain: f.terrain, lastSampledTrackbedSegments: tram,
        lastCellRenderedSegments: tram, sampledTrackbedRevision: 1,
        lastRenderCenterX: 20, lastRenderCenterZ: 20, pendingEmbeddedTramMeshRefresh: null,
        isOrdinaryOsmTramFeature: () => true, railSegmentsIntersectingBounds: segments => segments,
        resampleEmbeddedTramRoadSegmentHeightsSteps: function* (road, segments, options) {
            const start = y(road); r.phases.push(['resample-before', road, start, options]);
            yield { phase: 'resample' };
            const end = y(road); r.phases.push(['resample-after', road, end]);
            return segments.map(s => ({ ...s, yStart: start, yEnd: end }));
        },
        publishRailCandidateSteps: function* (candidate, options) {
            assert.equal(options.ground, r.context.pendingEmbeddedTramMeshRefresh.ground);
            r.phases.push(['staged', candidate]);
            yield { phase: 'boundary' };
            if (!options.isCurrent()) return false;
            r.context.lastSampledTrackbedSegments = candidate.segments;
            r.context.lastCellRenderedSegments = candidate.cellRenderedSegments;
            r.context.sampledTrackbedRevision++;
            candidate.committed = true;
            r.phases.push(['publish', candidate.segments]);
            return true;
        },
        changedRailSegmentRenderCellKeys: () => ['cell'],
    });
    const embedded = railSource.slice(railSource.indexOf('function rebuildEmbeddedTramMeshes('), railSource.indexOf('function scheduleRailStructuresRefresh('));
    vm.runInContext(embedded, r.context);
    return { ...r, model,
        schedule: (bounds = []) => r.context.scheduleEmbeddedTramMeshRefresh(20, 20, bounds),
        stepEmbedded: () => r.context.stepPendingEmbeddedTramMeshRefresh(),
        discardEmbedded: () => r.context.discardPendingEmbeddedTramMeshRefresh(),
    };
}

test('embedded tram refresh retains captured road queries across resample yields', () => {
    const f = fixture(), r = embeddedTramRuntime(f); r.schedule();
    advanceUntil(r.stepEmbedded, () => r.phases.some(phase => phase[0] === 'resample-before'));
    const pending = r.context.pendingEmbeddedTramMeshRefresh, ground = pending.ground;
    assert.equal(r.context.lastSampledTrackbedSegments[0].yStart, 1);
    assert.notEqual(ground.roadFormation, f.model);
    f.retire(); r.model.dispose(); // the consumer alone now owns the captured callbacks
    near(y(ground.roadFormation), 2);
    assert.equal(r.stepEmbedded(), true);
    assert.notEqual(r.context.pendingEmbeddedTramMeshRefresh, pending, 'retired source cannot publish');
    assert.equal(r.context.lastSampledTrackbedSegments[0].yStart, 1);
    assert.equal(r.phases.some(phase => phase[0] === 'publish'), false);
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    r.discardEmbedded(); finishRailLifetime(f, r.model);
});

test('embedded publication retains old queries and its ground lease until the prepared group lands', () => {
    const f = fixture(), r = embeddedTramRuntime(f); r.schedule();
    advanceUntil(r.stepEmbedded, () => r.phases.some(phase => phase[0] === 'resample-before'));
    const pending = r.context.pendingEmbeddedTramMeshRefresh, ground = pending.ground;
    const old = r.context.lastSampledTrackbedSegments;
    assert.equal(r.stepEmbedded(), true);
    assert.equal(r.context.pendingEmbeddedTramMeshRefresh, pending);
    assert.equal(r.context.lastSampledTrackbedSegments, old);
    assert.equal(r.phases.at(-1)[0], 'staged');
    const held = ground.retain('boundary-wait'); held.release();
    assert.equal(r.stepEmbedded(), true);
    assert.equal(r.context.pendingEmbeddedTramMeshRefresh, null);
    near(r.context.lastSampledTrackbedSegments[0].yStart, 2);
    assert.equal(r.phases.find(phase => phase[0] === 'resample-after')[1], ground.roadFormation);
    assert.equal(r.phases.at(-1)[0], 'publish');
    r.discardEmbedded();
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    finishRailLifetime(f, r.model);
});

test('embedded tram refresh rejects stale source segments and carries original and intervening bounds', () => {
    const f = fixture(), r = embeddedTramRuntime(f);
    const oldBounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    const newBounds = { minX: 20, maxX: 30, minZ: 20, maxZ: 30 };
    r.schedule([oldBounds]);
    advanceUntil(r.stepEmbedded, () => r.context.pendingEmbeddedTramMeshRefresh.ground);
    const pending = r.context.pendingEmbeddedTramMeshRefresh, ground = pending.ground;
    r.context.lastSampledTrackbedSegments = [];
    const getChangesSince = f.model.getChangesSince;
    f.model.getChangesSince = () => ({ full: false, bounds: [newBounds] });
    assert.equal(r.stepEmbedded(), true); assert.notEqual(r.context.pendingEmbeddedTramMeshRefresh, pending);
    assert.deepEqual(Array.from(r.context.pendingEmbeddedTramMeshRefresh.changedBounds), [oldBounds, newBounds]);
    assert.throws(() => ground.retain('late'), { code: 'read-snapshot-released' });
    assert.equal(r.phases.some(phase => phase[0] === 'publish'), false);
    f.model.getChangesSince = getChangesSince;
    r.discardEmbedded(); finishRailLifetime(f, r.model);
});

test('embedded tram refresh sampler failure releases captured owners without frame retry', () => {
    const f = fixture(), r = embeddedTramRuntime(f); let calls = 0;
    const resample = r.context.resampleEmbeddedTramRoadSegmentHeightsSteps;
    r.context.resampleEmbeddedTramRoadSegmentHeightsSteps = function* () { calls++; throw new Error('embedded-failure'); };
    r.schedule();
    for (let i = 0; i < 100 && !r.context.pendingEmbeddedTramMeshRefresh?.failure; i++) {
        try { r.stepEmbedded(); } catch (error) { assert.match(error.message, /embedded-failure/); }
    }
    assert.equal(calls, 1); for (let i = 0; i < 60; i++) assert.equal(r.stepEmbedded(), false); assert.equal(calls, 1);
    const failed = r.context.pendingEmbeddedTramMeshRefresh;
    assert.equal(failed.ground, null); assert.equal(failed.iterator, null);
    assert.equal(r.phases.some(phase => phase[0] === 'publish'), false);
    f.replace(109); r.context.resampleEmbeddedTramRoadSegmentHeightsSteps = resample;
    r.stepEmbedded(); assert.notEqual(r.context.pendingEmbeddedTramMeshRefresh, failed);
    advanceUntil(r.stepEmbedded, () => !r.context.pendingEmbeddedTramMeshRefresh);
    near(r.context.lastSampledTrackbedSegments[0].yStart, 9);
    finishRailLifetime(f, r.model);
});
