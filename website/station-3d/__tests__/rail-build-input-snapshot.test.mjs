import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RailFormationModel } from '../core/rail-formation.js';
import { TerrainReference, TerrainGrid } from '../core/terrain-grid.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { RoadFormationModel } from '../core/road-formation.js';
import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import { detectAtGradeLevelCrossingsSteps } from '../world/level-crossing-detect.js';
import { flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
    flagRailFormationBoundarySegmentsForRoadOpeningsSteps, noteRailCivilGroundMutation,
    railCivilGroundDependencySnapshotSteps, roadUnderRailFormationOpenings } from '../core/rail-road-grade-separation.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { changedCivilGroundDependencyBoundsSteps } from '../core/civil-ground-composition.js';

const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function createRailFormationModel('),
    source.indexOf('function installRailCivilGroundSnapshot('));
const lon = 16.4, lat = 43.52;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(lat * DEG_TO_RAD);
const geo = (x, z) => [lon + x / lonScale, lat - z / latScale];
function grid(offset = 0) {
    const side = 61, step = 100, min = -1000;
    const values = new Uint16Array(side ** 2);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
        values[z * side + x] = Math.round((100 + offset + (min + x * step) * .001) * 100);
    }
    return new TerrainGrid({ grid: { width: side, height: side, bounds: {
        west: geo(min - step / 2, 0)[0], east: geo(min + (side - .5) * step, 0)[0],
        north: geo(0, min - step / 2)[1], south: geo(0, min + (side - .5) * step)[1],
    } }, encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } }, values.buffer);
}
function fixture() {
    const terrain = new TerrainReference(grid(), lon, lat, { surfaceStepM: 20 });
    const stationCalls = [];
    const context = vm.createContext({
        lastTerrain: { captureReadSnapshot() { throw new Error('published receiver is not construction evidence'); } },
        lastTerrainSource: terrain, lastRailFormation: null, lastStops: [Object.freeze({ stopId: 'old' })],
        lastAnchorLat: lat, lastAnchorLon: lon, lastPhotoTrackFrame: null,
        RailFormationModel, captureGroundReadSnapshot, ownReadSnapshot, retainReadSnapshot,
        getRailFormationHalfWidthMeters: () => 4,
        getRenderedRailTrackbedHalfWidthAtSpacingMeters: () => 3,
        buildPlannerSurfaceCutStationAccessPlans: input => { stationCalls.push(input); return []; },
    });
    vm.runInContext(code, context);
    return { terrain, context, stationCalls };
}
function drain(iterator) { let next; do next = iterator.next(); while (!next.done); return next.value; }
const features = [{ type: 'Feature', properties: { source: 'cb-proposal', proposalId: 'test' },
    geometry: { type: 'LineString', coordinates: [geo(0, 0), geo(4000, 0)] } }];

test('the live rail factory captures terrain, datum and stops before deferred preparation', () => {
    const f = fixture();
    const expected = f.context.createRailFormationModel(features);
    f.stationCalls.length = 0;
    const pending = f.context.createRailFormationModel(features, { deferredBuild: true });
    let outcome;
    do { outcome = pending.stepPendingBuild(); } while (outcome.phase !== 'prepare:terrain');
    const originalDatum = f.terrain.anchorHeightM;
    f.terrain.replaceGrid(grid(30));
    f.context.lastTerrainSource = new TerrainReference(grid(60), lon, lat, { surfaceStepM: 20 });
    f.context.lastStops.push({ stopId: 'late' });
    while (pending.hasPendingBuild()) pending.stepPendingBuild();
    assert.deepEqual(pending.alignments[0].samples, expected.alignments[0].samples);
    assert.deepEqual(pending.profiles[0].points, expected.profiles[0].points);
    assert.equal(pending.absoluteSceneYAtHeight(125), 125 - originalDatum);
    assert.ok(f.stationCalls.length > 0);
    assert.deepEqual(Array.from(f.stationCalls[0].stops, stop => stop.stopId), ['old']);
    assert.equal(pending._assemblyContextKey, expected._assemblyContextKey);
    assert.notEqual(f.terrain.evidenceSceneYAtLocal(100, 0), pending.baseSceneYAtLocal(100, 0));
});

test('unknown mutable terrain providers cannot silently masquerade as captured inputs', () => {
    assert.throws(() => captureGroundReadSnapshot({ evidenceSceneYAtLocal: () => 1 }), TypeError);
    assert.throws(() => captureGroundReadSnapshot({ captureReadSnapshot: () => ({
        contract: 'station3d-ground-read-snapshot-v1', evidenceSceneYAtLocal: () => 1,
        absoluteToSceneY: value => value,
    }) }), TypeError);
    const f = fixture(); f.context.lastTerrainSource = null;
    assert.equal(f.context.createRailFormationModel(features), null);
});


test('a staged rail formation uses its explicit terrain read without consulting live terrain or station inputs', () => {
    const f = fixture(), expected = f.context.createRailFormationModel(features);
    const read = captureGroundReadSnapshot(f.terrain, 'candidate');
    f.terrain.replaceGrid(grid(30));
    f.context.lastTerrainSource = { captureReadSnapshot() { throw new Error('live terrain read'); } };
    f.context.lastStops = [{ stopId: 'live-new' }];
    const pending = f.context.createRailFormationModel(features, { terrainRead: read, deferredBuild: true,
        stops: [Object.freeze({ stopId: 'old' })], previousModel: null, anchorLat: lat, anchorLon: lon,
        photoTrackFrame: null });
    read.release?.();
    while (pending.hasPendingBuild()) pending.stepPendingBuild();
    assert.deepEqual(pending.alignments[0].samples, expected.alignments[0].samples);
    assert.deepEqual(pending.profiles[0].points, expected.profiles[0].points);
    assert.equal(pending._assemblyContextKey, expected._assemblyContextKey);
    assert.throws(() => f.context.createRailFormationModel(features, { terrainRead: {} }), /captured candidate terrain/);
    pending.dispose(); expected.dispose();
});

test('forks copy actual mutable flags and preserve queries at every preparation yield', () => {
    const f = fixture(), original = f.context.createRailFormationModel(features);
    const sourceProfile = original.profiles[0];
    sourceProfile.roadOpeningSegmentRanges = sourceProfile.points.map(() => [[.2, .3]]);
    const before = original.sceneYAtLocal(100, 0);
    assert.ok(Number.isFinite(before));
    const sourceFlags = sourceProfile.internalSegments.slice();
    const iterator = original.forkCompiledGenerationSteps();
    let result, yields = 0;
    for (;;) {
        const next = iterator.next();
        if (next.done) { result = next.value; break; }
        yields++;
        assert.equal(original.sceneYAtLocal(100, 0), before);
        assert.deepEqual(sourceProfile.internalSegments, sourceFlags);
        assert.deepEqual(sourceProfile.roadOpeningSegmentRanges[0], [[.2, .3]]);
    }
    assert.ok(yields > 0);
    const forkProfile = result.profiles[0];
    assert.notEqual(forkProfile, sourceProfile);
    assert.notEqual(forkProfile.roadOpeningSegmentRanges[0][0], sourceProfile.roadOpeningSegmentRanges[0][0]);
    forkProfile.internalSegments[0] = !sourceFlags[0];
    forkProfile.roadOpeningSegmentRanges[0][0][0] = .1;
    assert.deepEqual(sourceProfile.internalSegments, sourceFlags);
    assert.deepEqual(sourceProfile.roadOpeningSegmentRanges[0], [[.2, .3]]);
    const read = drain(result.captureReadSnapshotSteps({ baseSceneYAtLocal: result.baseSceneYAtLocal }));
    assert.deepEqual(read.profiles[0].roadOpeningSegmentRanges[0], [[.1, .3]]);
    assert.throws(() => { read.profiles[0].roadOpeningSegmentRanges[0][0][0] = .9; }, TypeError);
    original.dispose();
    assert.equal(result.sceneYAtLocal(100, 0), before);
    assert.equal(read.sceneYAtLocal(100, 0), before);
    read.release(); result.dispose();
});

function countedModel() {
    let owners = 0;
    const lease = () => {
        owners++; let live = true;
        return { retain: lease, release() { if (!live) return false; live = false; owners--; return true; } };
    };
    const readInputs = lease();
    const model = new RailFormationModel({ anchorLat: lat, anchorLon: lon, features,
        baseSceneYAtLocal: () => 5, readInputs });
    readInputs.release();
    return { model, owners: () => owners };
}

test('fork cancellation and stale input rejection release the private terrain owner', () => {
    const f = countedModel(), before = f.model.sceneYAtLocal(100, 0);
    assert.equal(f.owners(), 1);
    let iterator = f.model.forkCompiledGenerationSteps();
    assert.equal(iterator.next().done, false); assert.equal(f.owners(), 2);
    iterator.return(); assert.equal(f.owners(), 1);
    assert.equal(f.model.sceneYAtLocal(100, 0), before);
    iterator = f.model.forkCompiledGenerationSteps(); iterator.next();
    f.model.civilGroundMutationRevision = 1;
    assert.throws(() => drain(iterator), { code: 'rail-formation-snapshot-stale' });
    assert.equal(f.owners(), 1);
    f.model.dispose(); assert.equal(f.owners(), 0);
});

test('an immutable construction read forks after its source model is disposed without losing terrain ownership', () => {
    const f = countedModel();
    const read = drain(f.model.captureReadSnapshotSteps({ baseSceneYAtLocal: f.model.baseSceneYAtLocal }));
    const before = read.profiles[0].internalSegments.slice();
    f.model.profiles[0].internalSegments[0] = !before[0];
    f.model.dispose();
    const cancelled = read.forkCompiledGenerationSteps();
    assert.equal(cancelled.next().done, false); assert.equal(f.owners(), 2);
    cancelled.return(); assert.equal(f.owners(), 1);
    const fork = drain(read.forkCompiledGenerationSteps());
    assert.deepEqual(fork.profiles[0].internalSegments, before, 'later receiver flags cannot enter the construction fork');
    fork.profiles[0].internalSegments[0] = !before[0];
    assert.deepEqual(read.profiles[0].internalSegments, before);
    const height = read.sceneYAtLocal(100, 0);
    read.release();
    assert.equal(f.owners(), 1); assert.equal(fork.sceneYAtLocal(100, 0), height);
    fork.dispose(); assert.equal(f.owners(), 0);
});

function orderedFixture() {
    const f = fixture(), r = f.context;
    const track = { type: 'Feature', properties: { source: 'cb-proposal', proposalId: 'civil-order', elevationMode: 'ground-relative' },
        geometry: { type: 'LineString', coordinates: [[...geo(0, 0), 2], [...geo(100, 0), 2]] } };
    const terrain = captureGroundReadSnapshot(f.terrain, 'ordered-terrain');
    const road = new RoadFormationModel({ anchorLat: lat, anchorLon: lon, baseSceneYAtLocal: terrain.evidenceSceneYAtLocal });
    road.getSurfaceProfiles();
    const roadRead = drain(road.captureReadSnapshotSteps({ baseSceneYAtLocal: terrain.evidenceSceneYAtLocal, readInputs: terrain }));
    const alignment = new RoadVerticalAlignmentModel({ anchorLat: lat, anchorLon: lon,
        terrainSceneYAtLocal: terrain.evidenceSceneYAtLocal,
        captureTerrainSnapshot: () => retainReadSnapshot(terrain, 'ordered-alignment'),
        definitions: [{ id: 'under-rail', kind: 'underpass', memberOsmIds: ['road-1'], axis: [geo(50, -50), geo(50, 50)],
            profile: { type: 'terrain-offset', offsetM: -6 },
            crossSection: { carriagewayHalfWidthM: 3.25, formationHalfWidthM: 4 },
            crossings: [{ coordinate: geo(50, 0), stationM: 50, clearStartM: 45, clearEndM: 55, angleDeg: 90,
                upperComposition: { mode: 'rail', formationWidthM: 6 }, lowerComposition: { mode: 'road', formationWidthM: 10 } }],
        }] });
    alignment.getAlignments();
    const alignmentRead = drain(alignment.captureReadSnapshotSteps({ authoredPortalReplacements: [] }));
    Object.assign(r, { performance, railFormationRevision: 0, railSessionToken: 1, lastRoadFormation: road,
        lastRoadVerticalAlignments: alignment, streamedRailSessionContext: {},
        publishedRailCivilGroundSnapshot: {}, publishedRailCivilGroundSnapshotModel: null,
        publishedRailCivilGroundSnapshotRevision: -1, publishedRailCivilGroundSnapshotMutation: -1,
        pendingPublishedRailCivilGroundSnapshot: null, pendingRailVisualRefresh: null, pendingRailStructuresRefresh: null,
        pendingCrossingFormationRefresh: null, pendingEmbeddedTramMeshRefresh: null, publishedRailBoundaryInputs: null,
        levelCrossingAccum: new Map(), levelCrossingAccumRevision: 0, roadUnderRailOpeningAccum: new Map(),
        RAIL_CIVIL_GROUND_SNAPSHOT_PADDING_M: 12, LEVEL_CROSSING_WALL_CLEAR_M: 4.5,
        detectAtGradeLevelCrossingsSteps, flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
        flagRailFormationBoundarySegmentsForRoadOpeningsSteps, noteRailCivilGroundMutation,
        railCivilGroundDependencySnapshotSteps, roadUnderRailFormationOpenings, changedCivilGroundDependencyBoundsSteps,
        ensurePillarClearanceForFormation() {}, recordLayerFrameMs() {},
        discardPendingRailVisualRefresh() {}, discardPendingRailStructuresRefresh() {},
        discardPendingCrossingFormationRefresh() {}, discardPendingEmbeddedTramMeshRefresh() {},
    });
    const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
    vm.runInContext(part('function* prepareRailConstructionGroundSteps', '// Reuse every ordinary visual stage')
        + part('function* flagRetainingWallsForCrossingsSteps', '// Rails owns the ONE level-crossing detection.')
        + part('function railBoundaryInputs()', 'function sameRailBoundaryInputs')
        + part('function prepareRailBoundaryAcknowledgement', 'function* prepareRailBoundaryGroundSteps')
        + part('function prepareRailFormationPublication', 'function publishRailFormation'), r);
    let valid = true;
    const admission = Object.freeze({ features: [track], isCurrent: () => valid,
        constructionInputs: Object.freeze({ session: 1, inputRevision: 1, stops: r.lastStops,
            stopsSignature: JSON.stringify(r.lastStops), photoFrame: null }) });
    const construction = limits => r.prepareRailConstructionGroundSteps({ admission, terrain,
        maxSegments: 128, maxProfiles: 16, maxProfilePoints: 256, ...limits });
    return { ...f, r, terrain, roadRead, alignmentRead, construction, admission,
        ownership: construction => r.prepareRailOwnershipGroundSteps({ admission, construction, roadFormation: roadRead,
            verticalAlignments: alignmentRead, maxCrossings: 16, maxOpenings: 16,
            maxDependencyEntries: 64, maxDependencyBounds: 256 }),
        stale() { valid = false; },
        close() { r.lastRailFormation?.dispose(); roadRead.release(); alignmentRead.release(); terrain.release?.(); road.dispose(); alignment.dispose(); },
    };
}

test('managed road-only updates reuse rail construction but changed source, terrain or station inputs require a solve', () => {
    const f = orderedFixture();
    let original, ownership, previous, reused;
    try {
        original = drain(f.construction());
        assert.equal(original.usage.reused, false);
        previous = original.read.retain('published-construction');
        const before = JSON.stringify(previous.profiles.map(p => [p.internalSegments, p.roadOpeningSegmentRanges]));
        ownership = drain(f.ownership(original));
        ownership.discard(); original.discard();
        f.r.createRailFormationModel = () => { throw new Error('construction-solve-requested'); };
        reused = drain(f.construction({ previous }));
        assert.equal(reused.usage.reused, true);
        assert.equal(JSON.stringify(reused.read.profiles.map(p => [p.internalSegments, p.roadOpeningSegmentRanges])), before,
            'reuse starts from civil construction, without the last receiver opening flags');
        assert.equal(reused.read.sceneYAtLocal(50, 0), previous.sceneYAtLocal(50, 0));
        reused.discard();
        const cancelled = f.construction({ previous });
        assert.equal(cancelled.next().done, false); cancelled.return();
        for (const change of [{ session: 2 }, { inputRevision: 2 }, { stopsSignature: '[]' }, { photoFrame: {} }]) {
            assert.throws(() => drain(f.construction({ previous, admission: { ...f.admission,
                constructionInputs: { ...f.admission.constructionInputs, ...change } } })), /construction-solve-requested/);
        }
        assert.throws(() => drain(f.construction({ previous,
            terrain: Object.freeze({ ...f.terrain, revision: f.terrain.revision + 1 }) })), /construction-solve-requested/);
        const streamedTerrain = Object.freeze({ ...f.terrain, revision: f.terrain.revision + 1 });
        reused = drain(f.construction({ previous, terrain: streamedTerrain, reusePublished: true }));
        assert.equal(reused.usage.reused, true,
            'a road-priority generation keeps the published rail construction while terrain reconciliation remains queued');
        reused.discard(); reused = null;
    } finally { reused?.discard(); ownership?.discard(); original?.discard(); previous?.release(); f.close(); }
});

test('production rail construction and final road openings use distinct immutable reads in one reversible publication', () => {
    const f = orderedFixture(), registry = createSurfacePublicationRegistry();
    let construction, ownership;
    try {
        const removedBounds = { minX: 1000, maxX: 1010, minZ: 500, maxZ: 510 };
        f.r.publishedRailCivilGroundSnapshot = { entries: [{ signature: 'old-distant-collar', bounds: removedBounds }] };
        construction = drain(f.construction());
        const roadInput = construction.read.retain('future-road-profile');
        const before = JSON.stringify(roadInput.profiles.map(p => [p.internalSegments, p.roadOpeningSegmentRanges]));
        const steps = f.ownership(construction);
        for (;;) {
            const next = steps.next();
            assert.equal(f.r.lastRailFormation, null);
            assert.equal(JSON.stringify(roadInput.profiles.map(p => [p.internalSegments, p.roadOpeningSegmentRanges])), before);
            if (next.done) { ownership = next.value; break; }
        }
        assert.equal(ownership.finalize(), false, 'a detached receiver cannot retire its construction owner');
        assert.ok(ownership.changedBounds.some(bounds => Object.keys(removedBounds).every(key => bounds[key] === removedBounds[key])),
            'removed rail support outside the incoming source footprint still invalidates its neighbours');
        assert.ok(ownership.changedBounds.some(bounds => bounds.minX < 100 && bounds.maxX > 0),
            'new rail support is in the same complete dependency closure');
        const witnesses = [];
        for (let z = -12; z <= 12; z += .25) {
            const constructed = roadInput.civilGroundSceneYAtLocal(50, z);
            const received = ownership.read.civilGroundSceneYAtLocal(50, z);
            if (constructed !== null && received === null) witnesses.push({ x: 50, z, constructed });
        }
        assert.ok(witnesses.length > 0, 'an actual underpass opening removes rail batter support from the final receiver');
        const witness = witnesses[0];
        const publication = ownership.formationPublication;
        const entries = [publication.entry, ...ownership.additionalEntries].map((entry, i) => ({ ...entry,
            ticket: registry.begin({ key: `rail-order:${i}`, generation: 1 }) }));
        const batch = registry.prepareBatch(entries);
        assert.equal(batch.publish().status, 'published');
        assert.equal(publication.state, 'committed');
        assert.equal(publication.finalize(), true); assert.equal(ownership.finalize(), true);
        assert.equal(publication.state, 'published');
        assert.equal(f.r.lastRailFormation.civilGroundSceneYAtLocal(witness.x, witness.z), null);
        assert.equal(roadInput.civilGroundSceneYAtLocal(witness.x, witness.z), witness.constructed);
        assert.equal(f.r.roadUnderRailOpeningAccum.size, 1);
        assert.equal(f.r.publishedRailBoundaryInputs.rail, f.r.lastRailFormation);
        roadInput.release();
    } finally { ownership?.discard(); construction?.discard(); registry.close(); f.close(); }
});

test('rail construction cancellation, capacity rejection and a later publication failure retain the former authority', () => {
    const f = orderedFixture(), registry = createSurfacePublicationRegistry();
    let construction, ownership;
    try {
        assert.throws(() => drain(f.construction({ maxSegments: 1 })), { code: 'ground-generation-capacity' });
        assert.equal(f.r.lastRailFormation, null);
        const cancelled = f.construction(); assert.equal(cancelled.next().done, false); cancelled.return();
        construction = drain(f.construction()); ownership = drain(f.ownership(construction));
        const next = ownership.formationPublication.model;
        const entries = [ownership.formationPublication.entry, ...ownership.additionalEntries].map((entry, i) => ({ ...entry,
            ticket: registry.begin({ key: `rail-order:${i}`, generation: 1 }) }));
        const batch = registry.prepareBatch(entries, { commit() { throw new Error('late mask failure'); } });
        assert.throws(() => batch.publish(), /late mask failure/);
        ownership.discard(); construction.discard();
        assert.equal(next._disposed, true);
        assert.equal(f.r.lastRailFormation, null); assert.equal(f.r.roadUnderRailOpeningAccum.size, 0);
        assert.equal(f.r.publishedRailBoundaryInputs, null);
        assert.equal(ownership.finalize(), false);
        const stale = f.construction(); stale.next(); f.stale();
        assert.throws(() => drain(stale), { code: 'ground-generation-stale' });
    } finally { ownership?.discard(); construction?.discard(); registry.close(); f.close(); }
});
