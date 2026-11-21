// Exercise the actual world/roads publication adapter and frame driver with
// Three, the production triangle index, picking registry and batch lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { createGroundCoverFootprints } from '../core/ground-cover-footprints.js';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createTilePublicationTracker } from '../core/tile-publication-tracker.js';
import { registerAggregateEntityRanges, getEntityRegistryDebugState } from '../core/entity-interaction.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { compileSurfaceClaim, reviseSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { createWorldGroundPaint } from '../world/ground-paint.js';
import { createGroundPaintCache } from '../core/ground-paint-cache.js';
import { captureGroundPaintMaterialRows } from '../core/ground-paint-styles.js';
import { prepareFixedSurfacePublicationSteps } from '../core/fixed-surface-publication.js';
import { partitionRoadSurfaceMeshesSteps } from '../core/gta-road-surface-chunks.js';
import { buildRenderedRoadSurfaceTrimeshDataSteps, mergeRoadSurfaceMeshes } from '../core/gta-road-surface.js';
import { GTA_PHYSICS } from '../core/gta-config.js';
import { GTA_COLLISION_GROUPS } from '../core/gta-collision-groups.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { createRoadFeatureSourceIndex } from '../core/road-feature-sources.js';
import { roadRenderQueryBoundsSteps } from '../core/road-render-ground.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';
import { clipReceiverOpeningsSteps } from '../core/receiver-opening-geometry.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { boundsIntersectWithPadding } from '../core/tile-stream.js';
import { applyPlannerSurfaceCutout, createPlannerGeometryMaterialCache } from '../world/planner-surface-cutout.js';
import { unregisterShared } from '../core/dispose.js';
import * as groundReadEvidence from '../core/ground-read-evidence.js';

await RAPIER.init();

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const between = (a, b) => {
    assert.ok(source.includes(a) && source.includes(b), 'production adapter boundaries exist');
    return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
};
const drain = (steps, inspect = () => {}) => {
    for (let n = 0; n < 100000; n++) { const next = steps.next(); inspect(); if (next.done) return next.value; }
    throw new Error('Road publication did not converge');
};

function fixture() {
    let now = 0, errors = [], frameSequence = 0;
    let maskUpdates = 0;
    let targetBucket = null;
    const footprints = createGroundCoverFootprints({ onChanged: () => maskUpdates++ });
    const registry = createSurfacePublicationRegistry();
    const boundary = createGroundPublicationBoundary();
    const runtime = vm.createContext({ ...groundReadEvidence, THREE, SURFACE_CLASS, SURFACE_VERTICAL_RELATION, SURFACE_COVERAGE_STATE, SURFACE_RENDER_ORDER, reviseSurfaceClaim,
        createPlannerGeometryMaterialCache,
        plannerGeometryMaterials: createPlannerGeometryMaterialCache(),
        boundsIntersectWithPadding, clipReceiverOpeningsSteps, createReceiverFootprintSteps, GROUND_GENERATION_LIMITS,
        markInspectionLayer, markSurfaceClaim, registerAggregateEntityRanges,
        performance: { now: () => ++now }, recordLayerFrameMs() {}, console: { error: (...args) => errors.push(args) },
        roadsGroup: new THREE.Group(), surfacePublications: registry,
        groundPublications: boundary, groundPhysicsProvider: null, groundPaint: null,
        renderer: {}, camera: {}, scene: {}, getFrameChunkSequence: () => frameSequence,
        *prewarmDetachedObject() { yield { phase: 'controlled-upload', deferFrame: true }; },
        prepareGroundCoverRoadBucketSteps: footprints.prepareBucketSteps,
        roadRegionForTile: key => key, roadBucketKeyForMesh: () => targetBucket,
        SIDEWALK_LEVEL_TYPES: new Set(['footway']),
        markRoadAggregatesDirty: () => { runtime.roadAggregateRevision++; },
        roadBatcher: createGeometryBatcher(), renderedRoadSurfaces: createRenderedRoadSurfaceRegistry(),
        roadCollisionCandidatesByBucket: new Map(), roadCollisionDirtyOwnersByBucket: new Map(),
        roadCollisionBucketRevisions: new Map(), publishedRoadSurfaceOwnersByBucket: new Map(),
        roadAggregateEntityUnregister: new WeakMap(), roadAggregates: new Map(),
        roadEntries: new Map(), tileRoads: new Map(), tileFeatures: new Map(), roadReceiverGenerationLease: null, roadReceiverMutationEpoch: 0,
        groundFeatureBounds: new WeakMap(), roadRenderQueryBoundsSteps, DEG_TO_RAD, EARTH_RADIUS_M,
        anchorLat: 0, anchorLon: 0,
        tileBuildJobs: new Map(), tileRegistrationJobs: new Map(), ownReadSnapshot, retainReadSnapshot,
        roadFeatureSources: createRoadFeatureSourceIndex(createRoadFeatureIdentityIndex()),
        roadSurfaceUsesEngineeredFormation: () => true,
        roadBucketDescriptors: new Map(), roadSurfaceBucketsPendingPublication: new Set(),
        roadSurfaceTiles: createTilePublicationTracker(), roadAggregateRevision: 0,
    });
    vm.runInContext(between('function roadAggregatePublicationKey(', 'function roadBucketKeyForMesh(')
        + between('function markRoadCollisionOwnerDirty(', '// "Publish" no longer means')
        + between('function roadInspectionSpec(', 'function markRoadAggregatesDirty(')
        + between('function* collectRoadFeatureGroupSteps(', '// Rebuild every dirty bucket')
        + between('let pendingAssembleBuckets = [];', '// The settle-gated per-frame driver')
        + between('const roadEntriesNeedingRecheck = new WeakSet();', 'function* admitRoadGroundGenerationSteps(').replace(/typeof window !== 'undefined'/, 'false')
        + between('function* admitRoadGroundGenerationSteps(', 'function createRoadFeatureTask(')
        + '\nfunction pendingOwners() { return roadPendingBucketOwners; }'
        + '\nfunction queued() { return { pending: pendingAssembleBuckets.length, active: !!activeRoadAssemblyTask, failures: [...roadAggregateFailures.values()] }; }', runtime);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    function stage(bucket, owner, y, x = 0, surfaceType = 'road') {
        const geometry = new THREE.PlaneGeometry(20, 10); geometry.rotateX(-Math.PI / 2); geometry.translate(x, y, 0);
        const claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
            ownerId: owner, verticalBand: y > 5 ? 'bridge' : 'ground', supportReady: true });
        runtime.roadBucketDescriptors.set(bucket, { material, name: 'RoadAggregate:test',
            renderOrder: 1, inspection: { id: 'road-aggregate-test' }, surfaceClaim: claim });
        runtime.roadBatcher.removeOwner(bucket, owner);
        const mesh = new THREE.Mesh(geometry, material), group = new THREE.Group();
        mesh.name = 'RoadSurface:test';
        mesh.userData = { surfaceClaim: claim, surfaceType, selectableRoadSurface: true, entityKey: `test:road:${owner}`,
            groundCoverRing: [{ x: x - 10, z: -5 }, { x: x + 10, z: -5 }, { x: x + 10, z: 5 }, { x: x - 10, z: 5 }] };
        group.add(mesh); targetBucket = bucket;
        const published = runtime.publishRoadFeatureGroup(group, owner, bucket);
        runtime.roadSurfaceTiles.awaitBuckets(bucket, [bucket]);
        geometry.dispose(); // Only source CPU arrays are retained; never uploaded.
        return published;
    }
    const prepareFrame = options => {
        frameSequence++;
        return runtime.assembleDirtyRoadAggregates(options);
    };
    const frame = (budget = Infinity) => {
        frameSequence++;
        boundary.publishReady();
        return runtime.assembleDirtyRoadAggregates({ frameBudgetMs: budget, maxUploads: 3 });
    };
    const flush = (budget = Infinity) => {
        for (let n = 0; n < 500; n++) {
            frame(budget);
            if (budget !== Infinity || (!boundary.snapshot().pending && !runtime.queued().active
                && !runtime.queued().pending)) return;
        }
        throw new Error('Road frame driver failed to settle');
    };
    const candidate = bucket => {
        const task = runtime.roadBatcher.beginAssembly(bucket, { includeBounds: true });
        while (!task.step(Infinity)) {}
        return runtime.prepareRoadAggregatePublicationSteps(bucket, task.result(),
            runtime.roadBucketDescriptors.get(bucket), { isCurrent: task.isCurrent });
    };
    const root = bucket => runtime.roadAggregates.get(bucket)?.mesh;
    const yAt = (maxY = Infinity, x = 0) => runtime.renderedRoadSurfaces.supportYAt(x, 0, { maxY });
    const renderedY = bucket => {
        if (!root(bucket)) return null;
        root(bucket).updateMatrixWorld(true);
        return new THREE.Raycaster(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, -1, 0))
            .intersectObject(root(bucket))[0]?.point.y;
    };
    const close = () => {
        runtime.discardActiveRoadAssembly(); boundary.close(); registry.close({ retireActive: true });
        runtime.renderedRoadSurfaces.clear(); runtime.roadBatcher.clear(); material.dispose();
    };
    return { runtime, registry, boundary, frame, prepareFrame, stage, flush, candidate, root, yAt, renderedY, close, errors, footprints, material,
        selectBucket: value => { targetBucket = value; },
        maskUpdates: () => maskUpdates,
        advance: value => { now += value; }, nextFrame: () => frameSequence++ };
}

test('admitted road sources build real aggregates and publish tile membership only with their receiver', () => {
    const f = fixture(), r = f.runtime, bucket = 'surface/tile-a';
    const feature = { properties: { osm_id: 701 }, geometry: { type: 'Polygon',
        coordinates: [[[-10, -5], [10, -5], [10, 5], [-10, -5]]] } };
    const source = r.roadFeatureSources.prepare(feature, { tileKey: 'tile-a' }), key = source.identity.key;
    r.tileFeatures.set('tile-a', [feature]);
    r.tileFeatures.set('tile-b', [structuredClone(feature)]);
    for (const tile of ['empty', 'replaced', 'registering']) r.tileFeatures.set(tile, []);
    r.roadFeatureSources.setTile('tile-a', [source]);
    const old = { ...f.stage(bucket, key, 1), regionTileKey: 'tile-a', identity: source.identity,
        formationGeneration: 1, tileRefs: new Set(['tile-a']), pendingRefs: 0 };
    r.roadEntries.set(key, old); const oldTile = new Set([key]); r.tileRoads.set('tile-a', oldTile);
    f.flush(); const oldRoot = f.root(bucket);
    r.roadFeatureSources.setTile('tile-b', [r.roadFeatureSources.prepare(structuredClone(feature), { tileKey: 'tile-b' })]);
    let owners = 0, mode = 'built', sequence = 0, expectedSource = source;
    const lease = () => { owners++; let released = false;
        return { retain() { assert.equal(released, false); return lease(); },
            release() { if (!released) { released = true; owners--; } } }; };
    const proposals = Object.freeze({ isCurrent: () => true });
    const structures = Object.freeze({ getActive() { throw new Error('fixture must not use a live structure lookup'); } });
    const ground = ownReadSnapshot({ terrain: Object.freeze({ evidenceSceneYAtLocal: () => 5 }),
        roadFormation: Object.freeze({ getSurfaceGeometryGeneration: () => 9 }),
        structurePublications: structures, proposalMask: proposals, isCurrent: () => true }, [lease()]);
    r.createRoadFeatureTask = (builtFeature, tileKey, inputs) => {
        assert.equal(builtFeature, expectedSource.feature);
        assert.equal(tileKey, 'tile-a');
        const held = retainReadSnapshot(inputs, 'controlled-road-cross-section');
        assert.equal(held.structurePublications, structures); assert.equal(held.proposalMask, proposals);
        const root = new THREE.Group(); let visited = false, disposed = false;
        if (mode === 'built') {
            const geometry = new THREE.PlaneGeometry(20, 10); geometry.rotateX(-Math.PI / 2);
            geometry.translate(0, held.terrain.evidenceSceneYAtLocal(0, 0), 0);
            const mesh = new THREE.Mesh(geometry, f.material); mesh.name = 'RoadSurface:fixture';
            mesh.userData.terrainCutoutRegions = drain(createReceiverFootprintSteps({
                positions: geometry.attributes.position.array, indices: geometry.index.array, maxTriangles: 16 })).regions;
            mesh.userData.surfaceType = 'road'; root.add(mesh);
        }
        f.selectBucket(bucket);
        return { isCurrent: held.isCurrent, phaseLabel: () => 'controlled-cross-section', readEvidence: () => null,
            step() { if (!visited) { visited = true; return 'more'; } return mode === 'built' ? 'done' : 'abort'; },
            group: () => mode === 'built' ? root : null,
            omission: () => ({ kind: mode === 'excluded' ? 'excluded' : 'unavailable', reason: 'terrain-evidence' }),
            dispose() { if (!disposed) { disposed = true; held.release(); root.traverse(object => object.geometry?.dispose()); } } };
    };
    const before = () => {
        assert.equal(r.roadEntries.get(key), old); assert.equal(r.tileRoads.get('tile-a'), oldTile);
        assert.equal(r.tileRoads.has('tile-b'), false); assert.equal(f.root(bucket), oldRoot);
        assert.equal(f.yAt(), 1); assert.equal(f.renderedY(bucket), 1);
        for (const tile of r.tileFeatures.keys()) assert.equal(r.roadSurfaceTiles.isCurrent(tile), false,
            'source arrival, preparation and failed publication cannot acknowledge a road tile');
    };
    const finish = steps => { try { return drain(steps, () => { f.nextFrame(); before(); }); } finally { steps.return(); } };
    const admit = () => finish(r.admitRoadGroundGenerationSteps([key], { isCurrent: () => true, maxFeatures: 4 }));
    const prepare = (admission, extra = {}) => {
        expectedSource = admission.rows[0].source.selected;
        return finish(r.prepareRoadGroundGenerationSteps({ admission, ground, generation: ++sequence, isCurrent: () => true,
            maxBuckets: 32, maxSourceTiles: 32, ...extra }));
    };
    try {
        r.tileBuildJobs.set('tile-a', {}); assert.equal(admit(), null); r.tileBuildJobs.clear();
        r.pendingOwners().set(bucket, new Set([key])); assert.equal(admit(), null); r.pendingOwners().clear();
        r.pendingOwners().set('surface/far-away', new Set(['unrelated']));
        let admission = admit(); assert.ok(admission); admission.release(); r.pendingOwners().clear();
        admission = admit(); r.roadFeatureSources.removeTile('tile-b');
        r.roadFeatureSources.setTile('tile-b', [r.roadFeatureSources.prepare(feature, { tileKey: 'tile-b' })]);
        assert.equal(admission.isCurrent(), false); assert.equal(prepare(admission), null); assert.equal(owners, 1);
        mode = 'missing'; assert.throws(() => prepare(admit()), { code: 'road-receiver-evidence-unavailable' });
        before(); assert.equal(owners, 1); assert.equal(r.roadReceiverGenerationLease, null);
        mode = 'excluded'; let candidate = prepare(admit()); assert.ok(candidate);
        assert.equal(candidate.formationBackstopReady({ sourceOwnerKey: key,
            sourceRevisionKey: expectedSource.identity.revisionKey, osmId: 701 }), false,
        'an intentionally excluded source is not a physical replacement backstop');
        const cutBounds = { minX: -30, minZ: -30, maxX: 30, maxZ: 30 };
        assert.equal(drain(candidate.terrainCutoutRegionsSteps({ bounds: cutBounds, maxRegions: 4 })).length, 0);
        candidate.discard(); before(); assert.equal(owners, 1);
        mode = 'built';
        assert.throws(() => prepare(admit(), { maxSourceTiles: 1 }),
            { code: 'ground-generation-capacity' });
        before(); assert.equal(owners, 1);
        {
            const admission = admit();
            assert.throws(() => prepare(admission, { maxGeometryBytes: 1 }), error => {
                assert.equal(error.code, 'geometry-replacement-capacity');
                assert.equal(error.details.maxOutputBytes, 1);
                assert.ok(error.details.outputBytes > 1);
                return true;
            });
            before(); assert.equal(owners, 1);
            const admitted = prepare(admit(), { maxGeometryBytes: 1_000_000 });
            assert.ok(admitted);
            admitted.discard(); before(); assert.equal(owners, 1);
        }
        for (const fail of [true, false]) {
            admission = admit();
            r.roadFeatureSources.setTile('tile-a', [r.roadFeatureSources.prepare(structuredClone(feature), { tileKey: 'tile-a' })]);
            assert.equal(admission.isCurrent(), true, 'equivalent re-delivery does not cancel the receiver');
            candidate = prepare(admission); assert.ok(candidate); before(); assert.equal(owners, 2);
            const proof = { sourceOwnerKey: key, sourceRevisionKey: expectedSource.identity.revisionKey, osmId: 701 };
            assert.equal(candidate.formationBackstopReady(proof), true);
            assert.equal(candidate.formationBackstopReady({ ...proof, sourceRevisionKey: 'older-source' }), false);
            assert.equal(candidate.formationBackstopReady({ ...proof, sourceOwnerKey: 'absent' }), false);
            const cuts = drain(candidate.terrainCutoutRegionsSteps({ bounds: cutBounds, maxRegions: 4 }));
            assert.equal(cuts.length, 1, 'the private next receiver supplies the cut boundary before publication');
            assert.equal(r.roadEntries.get(key).terrainCutoutRegions.length, 0, 'the old receiver keeps its old cuts');
            assert.equal(cuts[0].ring.length, 4);
            try {
                const batch = f.registry.prepareBatch(candidate.entries, { commit() {
                    assert.equal(r.roadEntries.get(key).identity, expectedSource.identity);
                    assert.deepEqual([...r.roadEntries.get(key).tileRefs].sort(), ['tile-a', 'tile-b']);
                    assert.equal(r.roadEntries.get(key).formationGeneration, 9);
                    assert.equal(r.roadEntries.get(key).terrainCutoutRegions[0], cuts[0]);
                    assert.equal(r.tileRoads.get('tile-b').has(key), true);
                    if (fail) throw new Error('later ground member failed');
                } });
                if (fail) {
                    assert.throws(() => batch.publish(), /later ground member failed/); before();
                    assert.equal(owners, 1); assert.equal(candidate.isCurrent(), false);
                    assert.equal(r.roadReceiverGenerationLease, null);
                } else {
                    assert.ok(f.boundary.enqueue(batch, { onPublished: () => candidate.finalize() })); before();
                    r.tileFeatures.set('replaced', []);
                    r.tileRegistrationJobs.set('registering', {});
                    f.boundary.publishReady(); assert.equal(f.yAt(), 5); assert.equal(f.renderedY(bucket), 5);
                    for (const tile of ['tile-a', 'tile-b', 'empty']) assert.equal(r.roadSurfaceTiles.isCurrent(tile), true,
                        'successful shared publication acknowledges nonempty and empty source tiles');
                    for (const tile of ['replaced', 'registering']) assert.equal(r.roadSurfaceTiles.isCurrent(tile), false,
                        'an older publication does not acknowledge a superseding source receipt');
                    assert.equal(r.tileRoads.get('tile-a').has(key), true); assert.equal(r.tileRoads.get('tile-b').has(key), true);
                    assert.equal(owners, 1); assert.equal(r.roadReceiverGenerationLease, null);
                    assert.equal(candidate.isCurrent(), false);
                    assert.equal(candidate.formationBackstopReady(proof), false, 'settled candidate cannot authorize a later cut');
                    assert.throws(() => drain(candidate.terrainCutoutRegionsSteps({ bounds: cutBounds, maxRegions: 4 })),
                        { code: 'ground-generation-stale' });
                }
            } finally { candidate.discard(); }
        }
    } finally { r.roadReceiverGenerationLease?.cancel(); f.close(); ground.release(); assert.equal(owners, 0); }
});

function attachActualGta(f) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const gtaSource = readFileSync(new URL('../modes/gta.js', import.meta.url), 'utf8');
    const c = vm.createContext({ RAPIER, world, Map, Set, Float32Array, Uint32Array, Array, Number,
        GTA_PHYSICS, GTA_COLLISION_GROUPS, prepareFixedSurfacePublicationSteps, partitionRoadSurfaceMeshesSteps,
        buildRenderedRoadSurfaceTrimeshDataSteps, mergeRoadSurfaceMeshes,
        roadFormationReference: () => null, roadVerticalAlignmentReference: () => null,
        renderedRoadSurfaceRevision: (...args) => f.runtime.renderedRoadSurfaces.revisionNear(...args),
        renderedRoadSurfacePartsNear: (...args) => f.runtime.renderedRoadSurfaces.partsNear(...args),
        physicsOrigin: { x: 0, z: 0 }, toPhysics: (x, z) => ({ x, z }),
        fixedBodies: new Map(), colliderMetadata: new Map(), fixedColliderResourceCount: 0,
        pendingFixedSurfaces: null, fixedCapacityHits: 0, lastRenderedRoadSurfaceRevision: -1,
        GROUND_COLLIDER_KEYS: new Set(['terrain', 'road-surfaces']),
        entryColliders: entry => entry?.colliders || [],
        monotonicNowMs: () => performance.now(), recordLayerFrameMs() {},
        console: { error: (...args) => f.errors.push(args) },
    });
    const start = gtaSource.indexOf('    function* buildRoadSurfaceColliderSteps(');
    const end = gtaSource.indexOf('    function obstacleSpec(', start);
    assert.ok(start >= 0 && end > start, 'actual GTA road publication adapter boundaries exist');
    vm.runInContext(gtaSource.slice(start, end), c);
    assert.equal(c.publishFixedSurfaces([c.buildRoadSurfaceCollider(0, 0)]), true);
    const api = { captureGroundPublicationRegion: c.captureGroundPublicationRegion };
    f.runtime.groundPhysicsProvider = () => api;
    return {
        c, world,
        yAt(x = 0) {
            world.step();
            const hit = world.castRay(new RAPIER.Ray({ x, y: 20, z: 0 }, { x: 0, y: -1, z: 0 }), 40, true);
            return hit ? 20 - hit.timeOfImpact : null;
        },
        close() { f.close(); world.free(); },
    };
}

test('the live road frame driver publishes Three, query and real Rapier removal at one controller boundary', () => {
    const f = fixture(); f.stage('road', 'road', 1); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        assert.equal(gta.yAt(), 1);
        const old = f.root('road'), oldBody = gta.c.fixedBodies.get('road-surfaces');
        f.stage('road', 'road', 3);
        // Preparation runs through the real frame driver, not direct publish().
        f.prepareFrame({ frameBudgetMs: Infinity, maxUploads: 3 });
        assert.equal(f.boundary.snapshot().pending, 0, 'GPU preparation keeps the group private for another frame');
        f.prepareFrame({ frameBudgetMs: Infinity, maxUploads: 3 });
        assert.equal(f.boundary.snapshot().pending, 1);
        assert.equal(f.root('road'), old); assert.equal(f.yAt(), 1); assert.equal(gta.yAt(), 1);
        assert.equal(gta.world.colliders.len(), 2, 'disabled staged support is retained privately');
        const consumed = gta.c.lastRenderedRoadSurfaceRevision;
        assert.equal(consumed, r.renderedRoadSurfaces.revisionNear(0, 0, 110));
        f.boundary.publishReady();
        // No await: these are the reads the same frame's controller makes.
        assert.equal(f.renderedY('road'), 3); assert.equal(f.yAt(), 3); assert.equal(gta.yAt(), 3);
        assert.notEqual(gta.c.fixedBodies.get('road-surfaces'), oldBody);
        assert.equal(gta.world.colliders.len(), 1, 'old collider retired before controller entry');
        assert.equal(gta.c.pendingFixedSurfaces, null);
        assert.equal(gta.c.lastRenderedRoadSurfaceRevision, r.renderedRoadSurfaces.revisionNear(0, 0, 110));
        assert.ok(gta.c.lastRenderedRoadSurfaceRevision > consumed);
        f.frame();
        r.roadBatcher.removeOwner('road', 'road'); r.removeRoadCollisionSupportCandidate('road', 'road');
        r.roadAggregateRevision++;
        f.prepareFrame({ frameBudgetMs: Infinity, maxUploads: 3 });
        assert.equal(f.yAt(), 3); assert.equal(gta.yAt(), 3);
        f.boundary.publishReady();
        assert.equal(f.root('road'), undefined); assert.equal(f.yAt(), null); assert.equal(gta.yAt(), null);
        assert.equal(gta.world.colliders.len(), 0);
        assert.equal(gta.c.roadSurfaceStats.source, 'rendered');
        assert.equal(f.errors.length, 0);
    } finally { gta.close(); }
});

test('road collector is cooperative and side effect free before publication', () => {
    const f = fixture();
    const material = new THREE.MeshBasicMaterial();
    const root = new THREE.Group();
    const nested = new THREE.Group();
    const road = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    road.name = 'RoadSurface:road'; road.userData = { surfaceType: 'road', osmId: 42,
        selectableRoadSurface: true, entityKey: 'road:42', entityMetadata: { osmId: 42 },
        groundCoverRing: [{ x: 0, z: 0 }] };
    const bike = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    bike.name = 'RoadSurface:bike-lane'; bike.userData = { surfaceType: 'cycleway' };
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material); wall.name = 'RoadWall';
    nested.add(road, bike); root.add(new THREE.Group(), nested, wall);
    root.userData.groundPaintRecords = Object.freeze([Object.freeze({ key: 'paint:42' })]);
    const paintEvents = [];
    f.runtime.groundPaint = { stage: (...args) => paintEvents.push(args) };
    const snapshot = () => ({ batcher: f.runtime.roadBatcher.stats(), descriptors: f.runtime.roadBucketDescriptors.size,
        candidates: f.runtime.roadCollisionCandidatesByBucket.size, pending: [...f.runtime.roadSurfaceBucketsPendingPublication],
        dirty: f.runtime.roadCollisionDirtyOwnersByBucket.size, revision: f.runtime.roadAggregateRevision,
        collisionRevisions: [...f.runtime.roadCollisionBucketRevisions], paintEvents: paintEvents.slice() });
    const before = snapshot();
    const steps = f.runtime.collectRoadFeatureGroupSteps(root, 'owner', 'tile');
    let yields = 0, result;
    while (true) {
        const next = steps.next();
        if (next.done) { result = next.value; break; }
        yields++;
        assert.deepEqual(snapshot(), before);
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(yields, 6); assert.equal(result.parts, 3); assert.equal(result.surfaceParts, 2);
    assert.equal(result.paintBucketKey, 'RoadPaint@tile'); assert.deepEqual(result.paintRecords, root.userData.groundPaintRecords);
    for (const [i, mesh] of [road, bike, wall].entries()) {
        assert.equal(result.geometryParts[i].part.attributes.position, mesh.geometry.attributes.position.array);
        assert.equal(result.geometryParts[i].part.attributes.uv, mesh.geometry.attributes.uv.array);
        assert.equal(result.geometryParts[i].part.index, mesh.geometry.index.array);
    }
    assert.equal(result.geometryParts[0].part.entity.key, 'road:42');
    const collisions = [...result.collisionPartsByBucket.values()][0];
    assert.equal(collisions.map(p => p.drivable).join(','), 'true,false');
    assert.equal(collisions[0].id, 'owner:0'); assert.equal(collisions[0].osmId, 42);
    assert.equal(collisions[1].id, 'owner:1');
    assert.equal(collisions[0].groundCoverRing, road.userData.groundCoverRing);
    assert.equal(collisions[0].positions, road.geometry.attributes.position.array);
    f.runtime.publishRoadFeatureGroup(root, 'owner', 'tile');
    assert.equal(f.runtime.roadSurfaceBucketsPendingPublication.size, 2);
    assert.ok(f.runtime.roadSurfaceBucketsPendingPublication.has('RoadPaint@tile'));
    assert.ok(f.runtime.roadSurfaceBucketsPendingPublication.has(result.geometryParts[0].bucketKey));
    assert.equal(paintEvents.length, 1); assert.deepEqual(paintEvents[0][2], root.userData.groundPaintRecords);
    assert.equal(Object.values(f.runtime.roadBatcher.stats())[0].parts, 3);
    const assembled = f.runtime.roadBatcher.assemble(result.geometryParts[0].bucketKey);
    assert.deepEqual([...assembled.attributes.position], [road, bike, wall].flatMap(mesh => [...mesh.geometry.attributes.position.array]));
    material.dispose(); road.geometry.dispose(); bike.geometry.dispose(); wall.geometry.dispose(); f.close();
});

test('collector keeps ordinary earthwork support while excluding grade-separated collars', () => {
    const f = fixture();
    const material = new THREE.MeshBasicMaterial();
    const root = new THREE.Group();
    const make = (name, claim, drivable = false) => {
        const geometry = new THREE.PlaneGeometry(2, 2); geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, material); mesh.name = name;
        mesh.userData = { surfaceClaim: claim, drivable, groundCoverRing: drivable ? [{ x: 0, z: 0 }] : undefined };
        return mesh;
    };
    const top = make('RoadSurface:top', compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY, ownerId: 'top', verticalBand: 'ground', verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL, supportReady: true }), true);
    const collar = make('RoadFormationTerrainCollar:road', compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK, ownerId: 'collar', verticalBand: 'ground', verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL, supportReady: true }));
    const elevated = make('RoadFormationTerrainCollar:bridge', compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK, ownerId: 'elevated', verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED, supportReady: true }));
    root.add(top, collar, elevated);
    try {
        const result = drain(f.runtime.collectRoadFeatureGroupSteps(root, 'owner', 'tile'));
        const parts = [...result.collisionPartsByBucket.values()].flat();
        assert.deepEqual(parts.map(part => part.positions), [top, collar].map(mesh => mesh.geometry.attributes.position.array));
        assert.deepEqual(parts.map(part => part.drivable), [true, false]);
        assert.equal(parts[0].groundCoverRing, top.userData.groundCoverRing);
        assert.equal(parts[1].groundCoverRing, null);
        assert.equal(parts.some(part => part.positions === elevated.geometry.attributes.position.array), false);
    } finally { root.traverse(object => object.geometry?.dispose()); material.dispose(); f.close(); }
});

for (const openingKind of ['authored', 'planner']) test(`production road assembly publishes a ${openingKind} opening, retained terrain hole and its own floor with matching Rapier support`, () => {
    const f=fixture(),r=f.runtime;
    f.stage('road','road',1);f.flush();const gta=attachActualGta(f);
    const oldEntry={featureKey:'road',bucketKeys:new Set(['road']),surfaceBucketKeys:new Set(['road']),
        paintBucketKey:null,regionTileKey:'road',tileRefs:new Set(['road']),pendingRefs:0};
    r.roadEntries.set('road',oldEntry);
    const oldRoot=f.root('road'),material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),root=new THREE.Group();
    const plane=(width,depth,y)=>{const g=new THREE.PlaneGeometry(width,depth);g.rotateX(-Math.PI/2);g.translate(0,y,0);return g;};
    const top=new THREE.Mesh(plane(20,10,1),material),floor=new THREE.Mesh(plane(2,2,-1),material);
    top.name='RoadSurface:top';floor.name='RoadSurface:opening-floor';
    top.userData={surfaceType:'road',surfaceClaim:compileSurfaceClaim({surfaceClass:SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState:SURFACE_COVERAGE_STATE.BUILDING,verticalRelation:'same-level',
        ownerId:'road',replacementKey:'road',supportReady:true}),
        terrainCutoutRegions:drain(createReceiverFootprintSteps({positions:top.geometry.attributes.position.array,
            indices:top.geometry.index.array,maxTriangles:32})).regions};
    floor.userData={surfaceType:'road',surfaceClaim:compileSurfaceClaim({surfaceClass:SURFACE_CLASS.STRUCTURE,
        verticalRelation:'grade-separated',ownerId:'portal',replacementKey:'portal',supportReady:true})};
    root.add(top,floor);f.selectBucket('road');
    applyPlannerSurfaceCutout(material,reviseSurfaceClaim(top.userData.surfaceClaim,{coverageState:SURFACE_COVERAGE_STATE.PUBLISHED}));
    const originalPositions=top.geometry.attributes.position.array.slice(),originalIndices=top.geometry.index.array.slice();
    const openingRead=drain(createSurfaceOpeningReadSteps({[openingKind]:[{replacementKey:'portal',kind:'ramp',
        ring:[{x:-1,z:-1},{x:1,z:-1},{x:1,z:1},{x:-1,z:1}],minY:-2,maxY:2}],
        limits:{maxRegions:8,maxSourceVertices:32,maxCandidates:8,maxFragments:64}}));
    const assertOld=()=>{assert.equal(f.root('road'),oldRoot);assert.equal(f.renderedY('road'),1);assert.equal(f.yAt(),1);assert.equal(gta.yAt(),1);};
    const finish=steps=>drain(steps,()=>{f.nextFrame();assertOld();});
    try {
        const collected=finish(r.collectRoadFeatureGroupSteps(root,'road','road',openingRead));
        assert.equal(collected.descriptors.get('road').material.defines.ST3D_PLANNER_GEOMETRY_CUTOUTS,1);
        assert.equal(material.defines?.ST3D_PLANNER_GEOMETRY_CUTOUTS,undefined);
        const [topPart,floorPart]=collected.geometryParts.map(value=>value.part);
        const physical=collected.collisionPartsByBucket.get('road');
        assert.equal(physical[0].positions,topPart.attributes.position,'render and support use the exact same clipped positions');
        assert.equal(physical[0].indices,topPart.index);
        assert.equal(floorPart.attributes.position,floor.geometry.attributes.position.array,'replacement floor survives its own volume');
        assert.equal(collected.terrainCutoutRegions.length,1);
        assert.equal(collected.terrainCutoutRegions[0].holeRings.length,1,'old top polygon cannot erase terrain beneath the new hole');
        assert.deepEqual(top.geometry.attributes.position.array,originalPositions);
        assert.deepEqual(top.geometry.index.array,originalIndices);
        for(const fail of [true,false]) {
            const generation=fail?50:51,region=gta.c.captureGroundPublicationRegion(['road-surfaces']);
            const nextEntry={...oldEntry,parts:collected.parts,surfaceParts:collected.surfaceParts,
                terrainCutoutRegions:collected.terrainCutoutRegions};
            const candidate=finish(r.prepareRoadReceiverReplacementSteps([{featureKey:'road',previousEntry:oldEntry,nextEntry,collected}],
                {generation,isCurrent:()=>true,queryBounds:region.bounds,maxBuckets:8,maxSourceTiles:8}));
            assert.ok(candidate);
            const physics=finish(region.prepareSteps({'road-surfaces':candidate.roadSurfaceRead},candidate.isCurrent));
            assert.ok(physics);
            const batch=f.registry.prepareBatch([...candidate.entries,
                {...physics.entry,ticket:f.registry.begin({key:'ground:physics',generation}),clear:true}],
                {commit(){if(fail)throw new Error('opening backstop publication failed');}});
            if(fail) {
                assert.throws(()=>batch.publish(),/opening backstop publication failed/);assertOld();
                assert.equal(gta.world.colliders.len(),1);
            } else {
                assert.ok(f.boundary.enqueue(batch,{onPublished(){candidate.finalize();physics.finalize();}}));
                assertOld();f.boundary.publishReady();
                assert.equal(f.renderedY('road'),-1);assert.equal(f.yAt(),-1);assert.equal(gta.yAt(),-1);
                assert.equal(f.yAt(Infinity,3),1);assert.equal(gta.yAt(3),1);
                assert.deepEqual(f.errors,[]);
            }
        }
    } finally {
        top.geometry.dispose();floor.geometry.dispose();material.dispose();gta.close();
        for(const variant of r.plannerGeometryMaterials.take()){unregisterShared(variant);variant.dispose();}
    }
});

test('prepared road receivers keep source parts, Three roots and Rapier old until their complete replacement group commits', () => {
    const f = fixture(), r = f.runtime;
    f.stage('old', 'changed', 1); f.stage('old', 'retained', 2, 30); f.flush();
    const gta = attachActualGta(f);
    const oldEntry = { featureKey: 'changed', bucketKeys: new Set(['old']), surfaceBucketKeys: new Set(['old']),
        paintBucketKey: null, regionTileKey: 'old', tileRefs: new Set(['tile']), pendingRefs: 0 };
    r.roadEntries.set('changed', oldEntry);
    const oldRoot = f.root('old'), oldBuffers = r.roadBatcher.assemble('old');
    const oldCandidates = r.roadCollisionCandidatesByBucket.get('old');
    const oldBody = gta.c.fixedBodies.get('road-surfaces'), oldRevision = r.renderedRoadSurfaces.revision;
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(20, 10); geometry.rotateX(-Math.PI / 2); geometry.translate(0, 5, 0);
    const mesh = new THREE.Mesh(geometry, material), root = new THREE.Group();
    mesh.name = 'RoadSurface:replacement'; mesh.userData = { surfaceType: 'road', osmId: 42,
        surfaceClaim: compileSurfaceClaim({ surfaceClass: 'road-carriageway', ownerId: 'changed', verticalBand: 'ground', supportReady: true }),
        groundCoverRing: [{ x: -10, z: -5 }, { x: 10, z: -5 }, { x: 10, z: 5 }, { x: -10, z: 5 }] };
    root.add(mesh); r.roadBucketKeyForMesh = () => 'next';
    const collected = drain(r.collectRoadFeatureGroupSteps(root, 'changed', 'next'));
    const nextEntry = { ...oldEntry, bucketKeys: collected.bucketKeys, surfaceBucketKeys: collected.surfaceBucketKeys,
        regionTileKey: 'next', parts: collected.parts, surfaceParts: collected.surfaceParts };
    const rows = [{ featureKey: 'changed', previousEntry: oldEntry, nextEntry, collected }];
    const assertOld = () => {
        assert.equal(f.root('old'), oldRoot); assert.equal(f.root('next'), undefined);
        assert.equal(f.yAt(), 1); assert.equal(f.yAt(Infinity, 30), 2);
        assert.equal(gta.yAt(), 1); assert.equal(gta.yAt(30), 2);
        assert.equal(r.roadEntries.get('changed'), oldEntry);
        assert.equal(r.roadCollisionCandidatesByBucket.get('old'), oldCandidates);
        assert.equal(r.renderedRoadSurfaces.revision, oldRevision);
        assert.deepEqual([...r.roadBatcher.assemble('old').attributes.position], [...oldBuffers.attributes.position]);
        assert.equal(gta.c.fixedBodies.get('road-surfaces'), oldBody);
    };
    const finish = (steps, inspect = assertOld) => {
        try {
            for (let i = 0; i < 10000; i++) {
                f.nextFrame(); const next = steps.next(); inspect();
                if (next.done) return next.value;
            }
            assert.fail('Road receiver preparation did not converge');
        } finally { steps.return(); }
    };
    try {
        for (const fail of [true, false]) {
            const region = gta.c.captureGroundPublicationRegion(['road-surfaces']);
            const candidate = finish(r.prepareRoadReceiverReplacementSteps(rows, {
                generation: fail ? 20 : 21, queryBounds: region.bounds, isCurrent: () => true,
                maxBuckets: 32, maxSourceTiles: 32,
            }));
            assert.ok(candidate); assertOld();
            assert.equal(gta.world.colliders.len(), 1, 'receiver assembly does not acquire a separate physics reservation');
            const physics = finish(region.prepareSteps({ 'road-surfaces': candidate.roadSurfaceRead }, candidate.isCurrent));
            assert.ok(physics); assertOld();
            const observed = [];
            const unsubscribe = f.registry.subscribe(() => observed.push([f.yAt(), gta.yAt(), f.yAt(Infinity, 30), gta.yAt(30)]));
            const batch = f.registry.prepareBatch([...candidate.entries,
                { ...physics.entry, ticket: f.registry.begin({ key: 'ground:physics', generation: fail ? 20 : 21 }), clear: true }], {
                commit() { if (fail) throw new Error('later ground member failed'); },
            });
            if (fail) {
                assert.throws(() => batch.publish(), /later ground member failed/);
                assertOld(); assert.equal(observed.length, 0);
                assert.equal(gta.world.colliders.len(), 1);
                assert.equal(r.roadCollisionCandidatesByBucket.has('next'), false);
                assert.equal(r.roadBatcher.stats().next, undefined);
            } else {
                const queued = f.boundary.enqueue(batch, { onPublished() { candidate.finalize(); physics.finalize(); } });
                assert.ok(queued); assertOld(); f.boundary.publishReady();
                assert.equal(f.yAt(), 5); assert.equal(gta.yAt(), 5); assert.equal(f.renderedY('next'), 5);
                assert.equal(f.yAt(Infinity, 30), 2); assert.equal(gta.yAt(30), 2);
                assert.equal(r.roadEntries.get('changed'), nextEntry);
                assert.notEqual(f.root('old'), oldRoot); assert.equal(r.roadBatcher.stats().old.owners, 1);
                assert.equal(r.roadBatcher.stats().next.owners, 1); assert.equal(gta.world.colliders.len(), 1);
                assert.ok(observed.length >= 3); assert.ok(observed.every(values => values.join(',') === '5,5,2,2'));
            }
            unsubscribe();
        }
        assert.deepEqual(f.errors, []);
    } finally { geometry.dispose(); material.dispose(); gta.close(); }
});

test('road receiver bucket budget counts geometry buckets separately from paint regions', () => {
    const f = fixture(), r = f.runtime;
    r.roadBucketKeyForMesh = mesh => mesh.userData.bucketKey;
    r.groundPaint = {
        bindRoot() {},
        *prepareReplacementsSteps(rows, isCurrent) {
            assert.equal(rows.length, 1);
            assert.equal(rows[0].bucketKey, 'RoadPaint@mixed');
            assert.deepEqual(rows[0].records, Object.freeze([paintRecord]));
            assert.equal(isCurrent(), true);
            return {
                entry: { ticket: { state: 'committed' }, isCurrent: () => true,
                    commit: () => true, rollback: () => true, discard: () => true },
                finalize: () => true, discard: () => true,
            };
        },
    };
    const paintRecord = Object.freeze({ kind: 'test-paint' });
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const makeMesh = (bucket, x) => {
        const geometry = new THREE.PlaneGeometry(4, 4); geometry.rotateX(-Math.PI / 2); geometry.translate(x, 2, 0);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = { bucketKey: bucket, surfaceType: 'road', groundPaintRecords: Object.freeze([paintRecord]),
            surfaceClaim: compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
                ownerId: 'mixed', verticalBand: 'ground', supportReady: true }) };
        return mesh;
    };
    const collect = root => drain(r.collectRoadFeatureGroupSteps(root, 'mixed', 'mixed'));
    try {
        const one = new THREE.Group(); one.userData.groundPaintRecords = Object.freeze([paintRecord]); one.add(makeMesh('geometry-one', 0));
        const collected = collect(one);
        const nextEntry = { featureKey: 'mixed', bucketKeys: collected.bucketKeys,
            surfaceBucketKeys: collected.surfaceBucketKeys, paintBucketKey: collected.paintBucketKey,
            paintRecords: collected.paintRecords, parts: collected.parts, surfaceParts: collected.surfaceParts };
        const rows = [{ featureKey: 'mixed', previousEntry: null, nextEntry, collected }];
        const candidate = drain(r.prepareRoadReceiverReplacementSteps(rows, {
            generation: 301, isCurrent: () => true, maxBuckets: 1, maxSourceTiles: 1,
        }), () => f.nextFrame());
        assert.ok(candidate);
        assert.equal(candidate.usage.geometryBuckets, 1);
        assert.equal(candidate.usage.dependencyBuckets, 2);
        candidate.discard();
        one.traverse(object => object.geometry?.dispose());

        const two = new THREE.Group(); two.userData.groundPaintRecords = Object.freeze([paintRecord]);
        two.add(makeMesh('geometry-one', 0), makeMesh('geometry-two', 8));
        const twoCollected = collect(two);
        const twoEntry = { featureKey: 'mixed', bucketKeys: twoCollected.bucketKeys,
            surfaceBucketKeys: twoCollected.surfaceBucketKeys, paintBucketKey: twoCollected.paintBucketKey,
            paintRecords: twoCollected.paintRecords, parts: twoCollected.parts, surfaceParts: twoCollected.surfaceParts };
        assert.throws(() => drain(r.prepareRoadReceiverReplacementSteps([
            { featureKey: 'mixed', previousEntry: null, nextEntry: twoEntry, collected: twoCollected },
        ], { generation: 302, isCurrent: () => true, maxBuckets: 1, maxSourceTiles: 1 }), () => f.nextFrame()),
        { code: 'ground-generation-capacity' });
        two.traverse(object => object.geometry?.dispose());
    } finally { material.dispose(); f.close(); }
});

test('road receiver cancellation and source supersession release preparation; an older pending group must publish before admission', () => {
    const f = fixture(), r = f.runtime;
    const material = new THREE.MeshBasicMaterial(), root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(20, 10); geometry.rotateX(-Math.PI / 2); geometry.translate(0, 5, 0);
    const mesh = new THREE.Mesh(geometry, material); mesh.name = 'RoadSurface:successor';
    mesh.userData = { surfaceType: 'road', surfaceClaim: compileSurfaceClaim({ surfaceClass: 'road-carriageway',
        ownerId: 'road', verticalBand: 'ground', supportReady: true }) }; root.add(mesh);
    try {
        f.stage('road', 'road', 1); f.flush();
        const previousEntry = { featureKey: 'road', bucketKeys: new Set(['road']), surfaceBucketKeys: new Set(['road']), paintBucketKey: null };
        r.roadEntries.set('road', previousEntry);
        const collected = drain(r.collectRoadFeatureGroupSteps(root, 'road', 'road'));
        const rows = [{ featureKey: 'road', previousEntry, nextEntry: { ...previousEntry }, collected }];
        const start = generation => r.prepareRoadReceiverReplacementSteps(rows, {
            generation, isCurrent: () => true, maxBuckets: 32, maxSourceTiles: 32 });
        let steps = start(20), reached = false;
        for (let i = 0; i < 10000; i++) {
            f.nextFrame(); const next = steps.next(); assert.equal(f.yAt(), 1);
            assert.equal(next.done, false);
            if (next.value?.phase === 'controlled-upload') { reached = true; break; }
        }
        assert.ok(reached); steps.return();
        // A normal successor still acquires the exact same support/batch slots.
        f.stage('road', 'road', 3); f.flush(); assert.equal(f.yAt(), 3);
        steps = start(21); assert.equal(steps.next().done, false);
        f.stage('road', 'road', 4);
        assert.equal(drain(steps), null); assert.equal(f.yAt(), 3);
        assert.throws(() => drain(start(22)), { code: 'ground-dependency-busy' });
        f.flush(); assert.equal(f.yAt(), 4); assert.deepEqual(f.errors, []);
        const oversized = { ...collected, bucketKeys: new Set(Array.from({ length: 33 }, (_, i) => `extra-${i}`)) };
        assert.throws(() => drain(r.prepareRoadReceiverReplacementSteps([{ ...rows[0], collected: oversized }],
            { generation: 23, isCurrent: () => true, maxBuckets: 32, maxSourceTiles: 32 })), /bucket capacity/);
        assert.equal(f.yAt(), 4);
    } finally { geometry.dispose(); material.dispose(); f.close(); }
});

test('scoped road admission omits an unchanged neighbour while retaining its published support backstop', () => {
    const f = fixture(), r = f.runtime, makeFeature = (osmId, lon, tileKey) => ({
        properties: { osm_id: osmId }, geometry: { type: 'Polygon',
            coordinates: [[[lon - 0.0001, -0.00005], [lon + 0.0001, -0.00005],
                [lon + 0.0001, 0.00005], [lon - 0.0001, -0.00005]]] }, tileKey });
    try {
        const changed = r.roadFeatureSources.prepare(makeFeature(801, 0, 'changed'), { tileKey: 'changed' });
        const retained = r.roadFeatureSources.prepare(makeFeature(802, 0.0005, 'retained'), { tileKey: 'retained' });
        r.roadFeatureSources.setTile('changed', [changed]); r.roadFeatureSources.setTile('retained', [retained]);
        const changedKey = changed.identity.key, retainedKey = retained.identity.key;
        const changedEntry = { ...f.stage('changed', changedKey, 1), identity: changed.identity,
            sourceFeature: changed.feature, formationGeneration: 4, tileRefs: new Set(['changed']), pendingRefs: 0 };
        const retainedEntry = { ...f.stage('retained', retainedKey, 2, 40), identity: retained.identity,
            sourceFeature: retained.feature, formationGeneration: 4, tileRefs: new Set(['retained']), pendingRefs: 0 };
        r.roadEntries.set(changedKey, changedEntry); r.roadEntries.set(retainedKey, retainedEntry);
        r.tileRoads.set('changed', new Set([changedKey])); r.tileRoads.set('retained', new Set([retainedKey])); f.flush();
        r.groundFeatureBounds.set(changed.feature, Object.freeze({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }));
        r.groundFeatureBounds.set(retained.feature, Object.freeze({ minX: 30, minZ: -10, maxX: 50, maxZ: 10 }));
        const retainedRoot = f.root('retained'), retainedSupport = f.yAt(Infinity, 40);
        const oldFormation = { getSurfaceProfiles: () => [], getSurfaceGeometryGeneration: () => 4 };
        const ground = Object.freeze({ roadFormation: oldFormation, isCurrent: () => true });
        const steps = r.admitRoadGroundGenerationSteps([changedKey, retainedKey], {
            ground, changedBounds: [{ minX: -20, minZ: -20, maxX: 20, maxZ: 20 }], readChanges: groundReadEvidence.createGroundChangeSet(), full: false,
            isCurrent: () => true, maxFeatures: 8,
        });
        let admission;
        for (;;) { const next = steps.next(); if (next.done) { admission = next.value; break; } }
        assert.ok(admission);
        assert.equal(admission.rows.length, 1);
        assert.equal(admission.rows[0].featureKey, changedKey);
        assert.equal(admission.usage.retainedOwners, 1);
        assert.equal(f.root('retained'), retainedRoot);
        assert.equal(f.yAt(Infinity, 40), retainedSupport);
        steps.return(); admission.release();

        for (const [entry, bucket] of [[changedEntry, 'changed'], [retainedEntry, 'retained']]) {
            const geometry = f.root(bucket).geometry;
            entry.terrainCutoutRegions = drain(createReceiverFootprintSteps({
                positions: geometry.attributes.position.array, indices: geometry.index.array, maxTriangles: 8 })).regions;
        }
        r.roadFeatureSources.setTile('changed', []);
        const inputs = ownReadSnapshot({ roadFormation: oldFormation,
            structurePublications: Object.freeze({ getActive: () => null }),
            proposalMask: Object.freeze({ isCurrent: () => true }), isCurrent: () => true }, []);
        const prepareRemoval = () => {
            const admitted = drain(r.admitRoadGroundGenerationSteps([changedKey, retainedKey], {
                ground: inputs, readChanges: groundReadEvidence.createGroundChangeSet(), full: false, isCurrent: () => true, maxFeatures: 8 }));
            assert.equal(admitted.rows.length, 1); assert.equal(admitted.rows[0].featureKey, changedKey);
            return drain(r.prepareRoadGroundGenerationSteps({ admission: admitted, ground: inputs, generation: 30,
                full: false, isCurrent: () => true, maxBuckets: 32, maxSourceTiles: 32 }));
        };
        try {
            for (const rollback of [false, true]) {
                const candidate = prepareRemoval();
                assert.equal(candidate.usage.sourceOwners.removedOwners, 1);
                assert.equal(candidate.usage.sourceOwners.retainedOwners, 1);
                assert.equal(candidate.usage.sourceOwners.compiledOwners, 0);
                const cuts = drain(candidate.terrainCutoutRegionsSteps({
                    bounds: { minX: -20, minZ: -20, maxX: 60, maxZ: 20 }, maxRegions: 8 }));
                assert.equal(cuts.length, retainedEntry.terrainCutoutRegions.length);
                assert.equal(cuts[0], retainedEntry.terrainCutoutRegions[0],
                    'retained backstop survives sparse admission; removed owner no longer cuts terrain');
                if (rollback) {
                    const batch = f.registry.prepareBatch(candidate.entries, {
                        commit() { throw new Error('later member failed'); } });
                    assert.throws(() => batch.publish(), /later member failed/);
                } else candidate.discard();
                assert.equal(f.root('retained'), retainedRoot);
                assert.equal(f.yAt(Infinity, 40), retainedSupport);
                assert.equal(f.yAt(), 1, 'cancelled removal retains old support');
                assert.equal(r.roadEntries.get(changedKey), changedEntry);
                assert.equal(r.roadReceiverGenerationLease, null);
            }
        } finally { inputs.release(); }
    } finally { f.close(); }
});

test('one source crossing material buckets publishes both tops and one complete Rapier successor together', () => {
    const f = fixture();
    f.stage('west', 'shared', 1); f.stage('east', 'shared', 2, 30); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        const west = f.root('west'), east = f.root('east');
        let uploads = 0;
        r.prewarmDetachedObject = function* (root) {
            assert.equal(root.parent, null);
            uploads++; yield { phase: 'controlled-upload', deferFrame: true };
        };
        f.stage('west', 'shared', 3); f.stage('east', 'shared', 4, 30);
        const oldRevision = r.renderedRoadSurfaces.revision;
        for (let frame = 0; frame < 100 && !f.boundary.snapshot().pending; frame++) {
            const before = uploads;
            f.prepareFrame({ frameBudgetMs: Infinity, maxUploads: 1 });
            assert.ok(uploads-before <= 1, 'at most one GPU preparer advances per frame');
            assert.equal(f.root('west'), west); assert.equal(f.root('east'), east);
            assert.equal(f.yAt(), 1); assert.equal(f.yAt(Infinity, 30), 2);
            assert.equal(gta.yAt(), 1); assert.equal(gta.yAt(30), 2);
        }
        assert.equal(f.boundary.snapshot().pending, 1);
        assert.equal(uploads, 2);
        assert.equal(gta.world.colliders.len(), 2, 'the whole group shares one staged support set');
        const observed = [];
        f.registry.subscribe(event => { if (event.type === 'published') {
            observed.push([f.yAt(), f.yAt(Infinity, 30), gta.yAt(), gta.yAt(30)]);
        } });
        f.boundary.publishReady();
        assert.deepEqual(observed, [[3,4,3,4], [3,4,3,4]]);
        assert.notEqual(f.root('west'), west); assert.notEqual(f.root('east'), east);
        assert.equal(r.renderedRoadSurfaces.revision, oldRevision+1, 'both support buckets advance one query generation');
        assert.equal(gta.world.colliders.len(), 1);
        assert.equal(gta.c.pendingFixedSurfaces, null);
        f.flush();
        assert.equal(r.queued().pending, 0); assert.equal(r.queued().active, false);
        assert.equal(f.errors.length, 0);
    } finally { gta.close(); }
});

test('complete ground receiver budget admits many small buckets without weakening geometry or atomic publication limits',()=>{
    const f=fixture(),r=f.runtime,rows=[],geometries=[];
    try {
        for(let i=0;i<34;i++) {
            const key=`bounded:${i}`,old={...f.stage(key,key,1,i*24),tileRefs:new Set([key]),pendingRefs:0};
            r.roadEntries.set(key,old);r.tileRoads.set(key,new Set([key]));
            rows.push({featureKey:key,previousEntry:old,replaceTileMembership:true});
        }
        f.flush();
        const oldRoots=rows.map(row=>f.root(row.featureKey));
        for(const [i,row]of rows.entries()) {
            const geo=new THREE.PlaneGeometry(20,10);geo.rotateX(-Math.PI/2);geo.translate(i*24,5,0);geometries.push(geo);
            const mesh=new THREE.Mesh(geo,f.material),group=new THREE.Group();mesh.name='RoadSurface:successor';
            mesh.userData={surfaceType:'road',surfaceClaim:compileSurfaceClaim({surfaceClass:'road-carriageway',
                ownerId:row.featureKey,verticalBand:'ground',supportReady:true})};group.add(mesh);f.selectBucket(row.featureKey);
            row.collected=drain(r.collectRoadFeatureGroupSteps(group,row.featureKey,row.featureKey));
            row.nextEntry={...row.previousEntry,parts:row.collected.parts,surfaceParts:row.collected.surfaceParts};
        }
        const options={generation:100,isCurrent:()=>true,maxBuckets:32,maxSourceTiles:256};
        assert.throws(()=>drain(r.prepareRoadReceiverReplacementSteps(rows,{...options,maxOwners:0})),{name:'TypeError'});
        assert.throws(()=>drain(r.prepareRoadReceiverReplacementSteps(rows,{...options,maxOwners:16,maxBuckets:256})),{code:'ground-generation-capacity'});
        assert.throws(()=>drain(r.prepareRoadReceiverReplacementSteps(rows,options)),{code:'ground-generation-capacity'});
        for(const [i,row]of rows.entries())assert.equal(f.root(row.featureKey),oldRoots[i]);
        const candidate=drain(r.prepareRoadReceiverReplacementSteps(rows,{...options,generation:101,maxBuckets:256}),()=>{
            f.nextFrame();assert.equal(f.yAt(Infinity,0),1);assert.equal(f.yAt(Infinity,33*24),1);
        });
        assert.equal(candidate.usage.dependencyBuckets,34);assert.equal(candidate.usage.geometryBuckets,34);
        assert.ok(candidate.usage.geometryBytes>0&&candidate.usage.geometryBytes<32768);
        const queued=f.boundary.enqueue(f.registry.prepareBatch(candidate.entries),{onPublished:candidate.finalize});
        assert.ok(queued);assert.equal(f.yAt(Infinity,0),1);f.boundary.publishReady();
        for(const [i,row]of rows.entries()) {
            assert.notEqual(f.root(row.featureKey),oldRoots[i]);assert.equal(f.yAt(Infinity,i*24),5);
            assert.equal(f.root(row.featureKey).geometry.attributes.position.getY(0),5);
        }
        assert.equal(f.registry.snapshot().pendingCount,0);assert.deepEqual(f.errors,[]);
    }finally{for(const geometry of geometries)geometry.dispose();f.close();}
});

test('a complete 2049-owner replacement reaches real geometry and support without the ordinary 2048-owner cap', () => {
    const f = fixture(), r = f.runtime, bucket = 'complete-owners', tile = 'source-tile', geometries = [];
    const old = { ...f.stage(bucket, 'owner:0', 1), tileRefs: new Set([tile]), pendingRefs: 0 };
    r.roadEntries.set('owner:0', old); r.tileRoads.set(tile, new Set(['owner:0'])); f.flush();
    const oldRoot = f.root(bucket), rows = [];
    try {
        for (let i = 0; i < 2049; i++) {
            const featureKey = `owner:${i}`;
            const geometry = new THREE.PlaneGeometry(.5, .5);
            geometry.rotateX(-Math.PI / 2); geometry.translate(i * 2, 5, 0); geometries.push(geometry);
            const mesh = new THREE.Mesh(geometry, f.material), group = new THREE.Group();
            mesh.name = 'RoadSurface:tiny';
            mesh.userData = { surfaceType: 'road', surfaceClaim: compileSurfaceClaim({
                surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY, ownerId: featureKey,
                verticalBand: 'ground', supportReady: true }) };
            group.add(mesh); f.selectBucket(bucket);
            const collected = drain(r.collectRoadFeatureGroupSteps(group, featureKey, tile));
            rows.push({ featureKey, previousEntry: i === 0 ? old : null, collected,
                nextEntry: { featureKey, bucketKeys: collected.bucketKeys, surfaceBucketKeys: collected.surfaceBucketKeys,
                    parts: collected.parts, surfaceParts: collected.surfaceParts, tileRefs: new Set([tile]) },
                replaceTileMembership: true });
        }
        const options = { generation: 200, isCurrent: () => true, maxBuckets: 32, maxSourceTiles: 32,
            queryBounds: { minX: -1, minZ: -1, maxX: 4097, maxZ: 1 } };
        assert.throws(() => drain(r.prepareRoadReceiverReplacementSteps(rows, options)),
            error => error.code === 'ground-generation-capacity' && /2049 > 2048/.test(error.message));
        assert.equal(f.root(bucket), oldRoot); assert.equal(f.yAt(), 1);
        const steps = r.prepareRoadReceiverReplacementSteps(rows, { ...options, maxOwners: 4096 });
        let candidate = null, yields = 0;
        for (let i = 0; i < 500000; i++) {
            const next = steps.next();
            assert.equal(f.root(bucket), oldRoot); assert.equal(f.yAt(), 1);
            assert.equal(r.roadEntries.size, 1); assert.equal(r.tileRoads.get(tile).size, 1);
            if (next.done) { candidate = next.value; break; }
            yields++; f.nextFrame();
        }
        assert.ok(candidate && yields > 2049, 'the real geometry/query pipeline cooperatively prepares the complete set');
        assert.equal(candidate.usage.owners, 2049); assert.equal(candidate.usage.geometryBuckets, 1);
        assert.ok(candidate.usage.geometryBytes > 0 && candidate.usage.geometryBytes < 1024 * 1024);
        assert.equal(candidate.roadSurfaceRead.supportYAt(0, 0), 5);
        assert.equal(candidate.roadSurfaceRead.supportYAt(4096, 0), 5);
        const batch = f.registry.prepareBatch(candidate.entries);
        assert.ok(f.boundary.enqueue(batch, { onPublished: candidate.finalize }));
        assert.equal(f.root(bucket), oldRoot); assert.equal(f.yAt(), 1);
        f.boundary.publishReady();
        assert.notEqual(f.root(bucket), oldRoot); assert.equal(f.yAt(), 5); assert.equal(f.yAt(Infinity, 4096), 5);
        assert.equal(f.renderedY(bucket), 5); assert.equal(r.roadEntries.size, 2049);
        assert.equal(r.tileRoads.get(tile).size, 2049); assert.equal(f.registry.snapshot().pendingCount, 0);
        assert.deepEqual(f.errors, []);
    } finally { for (const geometry of geometries) geometry.dispose(); f.close(); }
});

test('a later bucket failure rolls back every mesh and the complete shared support set', async () => {
    const f = fixture();
    f.stage('west', 'shared', 1); f.stage('east', 'shared', 2, 30); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        const west = f.root('west'), east = f.root('east');
        f.stage('west', 'shared', 3); f.stage('east', 'shared', 4, 30);
        const prepare = f.registry.prepareBatch;
        let injected = false;
        r.surfacePublications = { ...f.registry, prepareBatch(entries) {
            if (!injected) {
                injected = true;
                entries = [...entries, { ticket: f.registry.begin({ key: 'later-failure', generation: 1 }),
                    clear: true, commit() { throw new Error('later bucket failed'); } }];
            }
            return prepare(entries);
        } };
        for (let frame = 0; frame < 100 && !f.boundary.snapshot().pending; frame++) {
            f.prepareFrame({ frameBudgetMs: Infinity });
        }
        assert.equal(f.boundary.snapshot().pending, 1);
        f.boundary.publishReady();
        await Promise.resolve();
        assert.equal(f.root('west'), west); assert.equal(f.root('east'), east);
        assert.equal(f.yAt(), 1); assert.equal(f.yAt(Infinity, 30), 2);
        assert.equal(gta.yAt(), 1); assert.equal(gta.yAt(30), 2);
        assert.equal(gta.world.colliders.len(), 1); assert.equal(gta.c.pendingFixedSurfaces, null);
        f.frame();
        f.advance(3000); f.flush();
        assert.equal(f.yAt(), 3); assert.equal(f.yAt(Infinity, 30), 4);
        assert.equal(gta.yAt(), 3); assert.equal(gta.yAt(30), 4);
        assert.equal(gta.world.colliders.len(), 1);
    } finally { gta.close(); }
});

test('a source changing material bucket retires the old top with its new mesh and collider', () => {
    const f = fixture(); f.stage('old-material', 'changing-source', 1); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        const old = f.root('old-material');
        r.disposePublishedRoadEntry({ featureKey: 'changing-source', surfaceBucketKeys: new Set(['old-material']) });
        f.stage('new-material', 'changing-source', 3);
        for (let frame = 0; frame < 100 && !f.boundary.snapshot().pending; frame++) {
            f.prepareFrame({ frameBudgetMs: Infinity });
            assert.equal(f.root('old-material'), old);
            assert.equal(f.root('new-material'), undefined);
            assert.equal(f.yAt(), 1); assert.equal(gta.yAt(), 1);
        }
        assert.equal(f.boundary.snapshot().pending, 1);
        f.boundary.publishReady();
        assert.equal(f.root('old-material'), undefined);
        assert.equal(f.renderedY('new-material'), 3);
        assert.equal(f.yAt(), 3); assert.equal(gta.yAt(), 3);
        assert.equal(gta.world.colliders.len(), 1);
        f.flush();
        assert.equal(f.errors.length, 0);
    } finally { gta.close(); }
});

test('a group superseded during a later bucket upload frees private support and never publishes either stale root', () => {
    const f = fixture(); f.stage('west', 'shared', 1); f.stage('east', 'shared', 2, 30); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        const oldWest = f.root('west'), oldEast = f.root('east');
        const staged = [];
        r.prewarmDetachedObject = function* (root) {
            const item = { root, disposed: false, returned: false };
            staged.push(item);
            root.geometry.addEventListener('dispose', () => { item.disposed = true; });
            try { yield { phase: 'upload', deferFrame: true }; } finally { item.returned = true; }
        };
        f.stage('west', 'shared', 3); f.stage('east', 'shared', 4, 30);
        for (let frame = 0; frame < 100 && staged.length < 2; frame++) {
            f.prepareFrame({ frameBudgetMs: Infinity });
        }
        assert.equal(staged.length, 2); assert.equal(gta.world.colliders.len(), 2);
        assert.equal(f.boundary.snapshot().pending, 0);
        f.stage('east', 'shared', 5, 30);
        f.prepareFrame({ frameBudgetMs: Infinity });
        assert.equal(staged[0].disposed, true); assert.equal(staged[1].disposed, true);
        assert.equal(staged[1].returned, true, 'cancellation closes the outstanding upload iterator');
        assert.equal(f.root('west'), oldWest); assert.equal(f.root('east'), oldEast);
        assert.equal(gta.yAt(), 1); assert.equal(gta.yAt(30), 2);
        f.flush();
        assert.equal(f.yAt(), 3); assert.equal(f.yAt(Infinity, 30), 5);
        assert.equal(gta.yAt(), 3); assert.equal(gta.yAt(30), 5);
        assert.equal(gta.world.colliders.len(), 1);
        assert.equal(f.errors.length, 0);
    } finally { gta.close(); }
});

test('a joined road/GTA publication rolls back both physical readers and skips distant collider replacement', () => {
    const f = fixture(); f.stage('road', 'road', 1); f.flush();
    const gta = attachActualGta(f), r = f.runtime;
    try {
        const old = f.root('road'), oldBody = gta.c.fixedBodies.get('road-surfaces');
        f.stage('road', 'road', 4);
        const candidate = drain(f.candidate('road'), () => {
            assert.equal(f.yAt(), 1); assert.equal(gta.yAt(), 1);
        });
        const laterFailure = { ticket: f.registry.begin({ key: 'later', generation: 1 }), clear: true,
            commit() { throw new Error('reject joined road group'); } };
        assert.throws(() => f.registry.prepareBatch([candidate.entry, laterFailure]).publish(), /reject joined/);
        assert.equal(f.root('road'), old); assert.equal(f.yAt(), 1); assert.equal(gta.yAt(), 1);
        assert.equal(gta.c.fixedBodies.get('road-surfaces'), oldBody);
        assert.equal(gta.c.pendingFixedSurfaces, null); assert.equal(gta.world.colliders.len(), 1);
        const retry = drain(f.candidate('road'));
        assert.equal(retry.publish(), true); assert.equal(gta.yAt(), 4);
        const currentBody = gta.c.fixedBodies.get('road-surfaces');
        f.stage('far', 'far', 8, 1000); f.flush();
        assert.equal(gta.c.fixedBodies.get('road-surfaces'), currentBody);
        assert.equal(gta.world.colliders.len(), 1); assert.equal(f.yAt(), 4); assert.equal(gta.yAt(), 4);
        f.stage('footway', 'footway', 4.12, 0, 'footway'); f.flush();
        assert.ok(Math.abs(f.yAt() - 4.12) < 1e-6, 'the foot-support query still receives the new path');
        assert.equal(gta.c.fixedBodies.get('road-surfaces'), currentBody,
            'non-drivable path changes do not rebuild unchanged tyre support');
        assert.equal(gta.yAt(), 4);
        assert.equal(f.errors.length, 0);
    } finally { gta.close(); }
});

test('a late stencil writer preempts a private reader without starting two GPU steps in the same frame', () => {
    const f = fixture(), r = f.runtime;
    try {
        const uploaded = [], published = [];
        r.prewarmDetachedObject = function* (root) {
            uploaded.push(root); yield { phase: 'upload', deferFrame: true };
        };
        f.registry.subscribe(event => { if (event.type === 'published') published.push(event.key); });
        f.stage('reader', 'footpath', 1, 30, 'footway');
        r.roadBucketDescriptors.get('reader').renderOrder = -9;
        f.prepareFrame({ frameBudgetMs: Infinity });
        assert.equal(uploaded.length, 1);
        for (let call = 0; call < 3; call++) r.assembleDirtyRoadAggregates({ frameBudgetMs: Infinity });
        assert.equal(uploaded.length, 1, 'multiple flush entry points cannot advance GPU work in one scheduler frame');
        f.stage('writer', 'street', 2);
        r.roadBucketDescriptors.get('writer').renderOrder = -10;
        r.assembleDirtyRoadAggregates({ frameBudgetMs: Infinity });
        assert.equal(uploaded.length, 1, 'preempting a group cannot reset the frame GPU budget');
        assert.equal(f.root('reader'), undefined);
        f.flush();
        assert.deepEqual(published, ['roads:aggregate:writer', 'roads:aggregate:reader']);
        assert.equal(f.yAt(), 2); assert.equal(f.yAt(Infinity, 30), 1);
        assert.equal(f.errors.length, 0);
    } finally { f.close(); }
});

test('live aggregate adapter rolls back mesh, exact support and picking before observers; retry and clear agree', () => {
    const initialPicking = getEntityRegistryDebugState().objectCount;
    const f = fixture(), r = f.runtime;
    try {
        f.stage('road', 'road', 1); f.stage('deck', 'deck', 8); f.flush();
        const oldFootprints = [...f.footprints.rings()], oldMaskUpdates = f.maskUpdates();
        assert.equal(f.yAt(), 8); assert.equal(f.yAt(5), 1); assert.equal(f.renderedY('road'), 1);
        const old = f.root('road'), deck = f.root('deck');
        const oldOwners = r.publishedRoadSurfaceOwnersByBucket.get('road');
        const observations = [];
        f.registry.subscribe(() => observations.push({ support: f.yAt(5), rendered: f.renderedY('road') }));
        f.stage('road', 'road', 3);
        const assertOld = () => {
            assert.equal(f.root('road'), old); assert.equal(f.root('deck'), deck);
            assert.equal(f.yAt(5), 1); assert.equal(f.renderedY('road'), 1);
            assert.equal(r.roadSurfaceTiles.isCurrent('road'), false);
            assert.deepEqual([...f.footprints.rings()], oldFootprints);
            assert.equal(f.maskUpdates(), oldMaskUpdates);
        };
        const failed = drain(f.candidate('road'), assertOld);
        let disposals = 0; failed.entry.root.geometry.addEventListener('dispose', () => disposals++);
        const failureRow = { ticket: f.registry.begin({ key: 'later-ground-dependency', generation: 1 }), clear: true,
            commit() { throw new Error('later ground dependency failed'); } };
        const beforeRevision = r.renderedRoadSurfaces.revision;
        assert.throws(() => f.registry.prepareBatch([failed.entry, failureRow]).publish(), /later ground dependency failed/);
        assertOld(); assert.equal(failed.finalize(), false); assert.equal(disposals, 1);
        assert.equal(r.renderedRoadSurfaces.revision, beforeRevision);
        assert.equal(r.publishedRoadSurfaceOwnersByBucket.get('road'), oldOwners);
        assert.equal(r.roadCollisionDirtyOwnersByBucket.get('road').has('road'), true);
        assert.equal(getEntityRegistryDebugState().objectCount, initialPicking + 2);
        assert.equal(f.maskUpdates(), oldMaskUpdates, 'height-only replacement keeps its footprint without a mask repaint');
        assert.equal(observations.length, 0);
        const retry = drain(f.candidate('road'), assertOld);
        assert.equal(retry.publish(), true); assert.equal(retry.finalize(), false);
        assert.equal(f.yAt(5), 3); assert.equal(f.renderedY('road'), 3); assert.equal(f.yAt(), 8);
        assert.equal(r.roadSurfaceTiles.isCurrent('road'), true);
        assert.deepEqual(observations, [{ support: 3, rendered: 3 }]);
        assert.equal(getEntityRegistryDebugState().objectCount, initialPicking + 2);
        // Clear the exact same live adapter, including its retained collision owner.
        r.roadBatcher.removeOwner('road', 'road'); r.removeRoadCollisionSupportCandidate('road', 'road');
        r.roadAggregateRevision++; r.roadSurfaceTiles.awaitBuckets('road', ['road']);
        const clear = drain(f.candidate('road'));
        assert.equal(clear.entry.clear, true); assert.equal(f.yAt(5), 3);
        observations.length = 0;
        // Clearing the lower receiver preserves the independent deck.
        assert.equal(clear.publish(), true);
        assert.equal(f.root('road'), undefined); assert.equal(f.yAt(5), null); assert.equal(f.yAt(), 8);
        assert.equal([...f.footprints.rings()].length, 1, 'evicted road footprint is removed with its aggregate');
        assert.equal(r.roadSurfaceTiles.isCurrent('road'), true);
        assert.equal(getEntityRegistryDebugState().objectCount, initialPicking + 1);
    } finally { f.close(); }
    assert.equal(getEntityRegistryDebugState().objectCount, initialPicking);
});

test('the actual frame driver stages across frames and cancels a stale successor without leaking index ownership', () => {
    const f = fixture(), r = f.runtime;
    try {
        f.stage('road', 'road', 1); f.flush(); const old = f.root('road');
        f.stage('road', 'road', 2);
        f.flush(5); assert.equal(f.root('road'), old); assert.equal(f.yAt(), 1);
        assert.equal(r.queued().active, true);
        f.stage('road', 'road', 4);
        for (let i = 0; i < 500 && !r.roadSurfaceTiles.isCurrent('road'); i++) f.flush(5);
        assert.equal(r.roadSurfaceTiles.isCurrent('road'), true);
        assert.equal(f.yAt(), 4); assert.equal(f.renderedY('road'), 4); assert.equal(f.errors.length, 0);
        assert.equal(r.queued().active, false); assert.equal(r.queued().pending, 0);
        assert.equal(r.queued().failures.length, 0);
        f.stage('road', 'road', 5);
        const steps = f.candidate('road'); steps.next(); steps.return();
        const retry = drain(f.candidate('road')); assert.equal(retry.publish(), true);
        assert.equal(f.yAt(), 5);
    } finally { f.close(); }
});

test('live aggregate failures retain old support, back off and retry only a bounded number before new input', () => {
    const f = fixture(), r = f.runtime;
    try {
        f.stage('road', 'road', 1); f.flush(); const old = f.root('road');
        f.stage('road', 'road', 2);
        const real = r.renderedRoadSurfaces.preparePublicationSteps;
        let attempts = 0;
        r.renderedRoadSurfaces.preparePublicationSteps = function* () { attempts++; throw new Error('staging capacity unavailable'); };
        f.flush(); assert.equal(attempts, 1); assert.equal(f.root('road'), old); assert.equal(f.yAt(), 1);
        for (let i = 0; i < 10; i++) f.flush(); assert.equal(attempts, 1);
        f.advance(1000); f.flush(); assert.equal(attempts, 2);
        f.advance(2000); f.flush(); assert.equal(attempts, 3);
        f.advance(100000); f.flush(); assert.equal(attempts, 3);
        assert.equal(r.roadSurfaceTiles.isCurrent('road'), false);
        assert.equal(r.roadCollisionDirtyOwnersByBucket.get('road').has('road'), true);
        r.renderedRoadSurfaces.preparePublicationSteps = real;
        f.stage('road', 'road', 3); f.flush();
        assert.equal(f.yAt(), 3); assert.equal(r.roadSurfaceTiles.isCurrent('road'), true);
        assert.equal(r.queued().failures.length, 0);
    } finally { f.close(); }
});

test('production paving replaces its old road mesh and Rapier support in the paint boundary', async () => {
    const f=fixture(); f.stage('old','plaza',1); f.flush();
    const gta=attachActualGta(f);
    // The real terrain collider remains the physical receiver after retiring
    // the redundant drape. Painting must not allocate a new support collider.
    gta.world.createCollider(RAPIER.ColliderDesc.cuboid(20,.5,20).setTranslation(0,-.5,0));
    const painter={createTask({packet,targetLease}) {
        let transferred=false, disposed=false;
        return { async prepare(){}, step:()=>true,
            result() { transferred=true; return {receiver:packet.receiver,bounds:packet.bounds,
                size:packet.size,styles:packet.styles,target:targetLease.target,layer:targetLease.layer,
                patterns:{ready:true,released:false,texture:null},
                copyMaterialRows:()=>captureGroundPaintMaterialRows(packet.styles,null,packet.bounds),
                get disposed(){return disposed;}, dispose(){if(!disposed){disposed=true;targetLease.release();}}}; },
            dispose(){if(!transferred){disposed=true;targetLease.release();}} };
    },dispose(){}};
    const paint=createWorldGroundPaint({renderer:{domElement:new EventTarget()},registry:f.registry,boundary:f.boundary,
        cacheFactory:options=>createGroundPaintCache({...options,size:8,widthsM:[16,64,256],blockSize:2,
            maxTextureBytes:256,packetLimits:{pixels:64,draws:8,verticesPerPolygon:20},painter,
            queue:{enqueue(){throw new Error('Source preparation must use the road frame driver');},dispose(){}},
            frameSequence:f.runtime.getFrameChunkSequence})});
    f.runtime.groundPaint=paint;
    try {
        const claim=compileSurfaceClaim({surfaceClass:SURFACE_CLASS.SIDEWALK,coverageState:'published',
            ownerId:'plaza',featureId:'plaza',verticalBand:'ground',verticalRelation:'same-level',
            supportReady:false,cutsBackstop:false});
        paint.registerStyle('pavers',{id:1,revision:'m1',surfaceClass:SURFACE_CLASS.SIDEWALK,
            roughness:.95,metalness:0,normalInfluence:0,linearColor:[.5,.5,.5]});
        const group=new THREE.Group();
        group.userData.groundPaintRecords=Object.freeze([Object.freeze({key:'plaza',sourceRevision:'s1',materialKey:'pavers',materialRevision:'m1',
            receiver:paint.receiver,claim,polygons:[{outerRing:[{x:-4,z:-4},{x:4,z:-4},{x:4,z:4},{x:-4,z:4}],holeRings:[]}] })]);
        f.runtime.disposePublishedRoadEntry({featureKey:'plaza',surfaceBucketKeys:new Set(['old'])});
        const entry=f.runtime.publishRoadFeatureGroup(group,'plaza','new');
        assert.equal(entry.parts,0);
        assert.equal(entry.paintBucketKey,'RoadPaint@new');
        let sawStaged=false;
        for(let i=0;i<500;i++) {
            if(f.boundary.snapshot().pending) {
                sawStaged=true;
                assert.equal(paint.paintAt(0,0),null);
                assert.equal(f.yAt(),1); assert.ok(f.root('old')); assert.equal(gta.yAt(),1);
            }
            f.frame(); await Promise.resolve(); await Promise.resolve();
            if(!f.runtime.queued().active && !f.runtime.queued().pending && !f.boundary.snapshot().pending)break;
        }
        assert.deepEqual(f.errors,[]);
        assert.equal(sawStaged,true);
        assert.equal(f.root('old'),undefined);
        assert.equal(f.yAt(),null);
        assert.equal(gta.yAt(),0);
        assert.equal(paint.paintAt(0,0).record.key,'plaza');
        assert.equal(paint.paintAt(0,0).record.claim.capabilities.support,false);
        assert.equal(paint.snapshot().sourceRecords,1);
        assert.equal(f.runtime.roadSurfaceBucketsPendingPublication.size,0);
        const revision=paint.snapshot().sourceRevision, pageLayer=paint.snapshot().pages[2].layer;
        f.runtime.disposePublishedRoadEntry(entry);
        const moved=f.runtime.publishRoadFeatureGroup(group,'plaza','moved');
        async function settle() {
            for(let i=0;i<500;i++) {
                f.frame(); await Promise.resolve(); await Promise.resolve();
                if(!f.runtime.queued().active && !f.runtime.queued().pending && !f.boundary.snapshot().pending)return;
            }
            assert.fail('Paint dependency group failed to settle');
        }
        await settle();
        assert.deepEqual(f.errors,[]);
        assert.equal(paint.snapshot().sourceRevision,revision,'regional ownership move must not repaint unchanged pixels');
        assert.equal(paint.snapshot().pages[2].layer,pageLayer);
        f.runtime.disposePublishedRoadEntry(moved); await settle();
        assert.deepEqual(f.errors,[]);
        assert.equal(paint.snapshot().sourceRecords,0,'eviction follows the new region after the no-op paint move');
        assert.equal(paint.paintAt(0,0).record,null);
        assert.equal(paint.sourceAt(0,0),null);
        assert.equal(gta.yAt(),0);
    } finally {gta.close();paint.dispose();}
});

test('complete road preflight checks shared inputs once and renews validity after yields and before publication', () => {
    const f = fixture(), r = f.runtime, rows = [], buckets = [];
    const worldSource = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
    const wrapper = worldSource.slice(worldSource.indexOf('export function* prepareWorldGroundGenerationSteps'),
        worldSource.indexOf('function* prepareWorldGroundGraphSteps')).replace('export ', '');
    let checkRead;
    const createScope = Function('prepareWorldGroundGraphSteps', `${wrapper}; return prepareWorldGroundGenerationSteps;`)(
        function* (options) { checkRead = options.checkRead; return { isCurrent: () => true }; });
    const { withValidationScope } = createScope({}).next().value;
    let sourceChecks = 0, ownerChecks = 0;
    const originalGet = r.roadEntries.get;
    r.roadEntries.get = function(key) { ownerChecks++; return originalGet.call(this, key); };
    const isCurrent = () => { sourceChecks++; return true; };
    try {
        for (let i = 0; i < 8; i++) {
            const key = `scope-owner:${i}`, bucket = `scope-bucket:${i}`;
            const old = { ...f.stage(bucket, key, 1, i * 24),
                tileRefs: new Set([key]), pendingRefs: 0 };
            r.roadEntries.set(key, old); r.tileRoads.set(key, new Set([key]));
            rows.push({ featureKey: key, previousEntry: old, nextEntry: null,
                collected: null, replaceTileMembership: true });
            buckets.push(bucket);
        }
        f.flush();
        const oldRoots = buckets.map(bucket => f.root(bucket));
        assert.ok(oldRoots.every(Boolean));
        const oldRevision = r.renderedRoadSurfaces.revision;
        const unchanged = () => {
            buckets.forEach((bucket, i) => {
                assert.equal(f.root(bucket), oldRoots[i]);
                assert.equal(f.yAt(Infinity, i * 24), 1);
                assert.equal(r.roadBatcher.stats()[bucket].owners, 1);
            });
            assert.equal(r.renderedRoadSurfaces.revision, oldRevision);
        };
        let checkedVisits = 0;
        const prepare = generation => {
            const steps = r.prepareRoadReceiverReplacementSteps(rows, {
                generation, isCurrent, checkRead, maxBuckets: 32, maxSourceTiles: 32,
            });
            try {
                for (let i = 0; i < 10000; i++) {
                    sourceChecks = 0;
                    const next = withValidationScope(() => steps.next());
                    assert.ok(sourceChecks <= 1, 'one complete shared source check per uninterrupted visit');
                    if (sourceChecks) checkedVisits++;
                    if (next.done) return next.value;
                }
                assert.fail('bounded receiver preparation did not finish');
            } finally { steps.return(); }
        };
        const candidate = prepare(301);
        assert.ok(candidate); assert.ok(checkedVisits > 1, 'yields renew source validation'); unchanged();
        sourceChecks = ownerChecks = 0;
        const batch = f.registry.prepareBatch(candidate.entries, { isCurrent: candidate.isCurrent, withValidationScope });
        assert.equal(batch.state, 'staged');
        assert.equal(sourceChecks, 1, 'all aggregate entries share one dependency scan');
        assert.equal(ownerChecks, rows.length, 'each captured road owner is validated once, including unchanged owners');
        const changed = rows[1];
        r.roadEntries.set(changed.featureKey, { ...changed.previousEntry });
        sourceChecks = ownerChecks = 0;
        assert.equal(batch.publish().status, 'dependency-revised');
        assert.ok(ownerChecks > 0, 'the boundary rechecks the owner table after preparation');
        unchanged();
        assert.equal(f.registry.snapshot().pendingCount, 0);
        r.roadEntries.set(changed.featureKey, changed.previousEntry);
        const retry = prepare(302);
        sourceChecks = 0;
        const accepted = f.registry.prepareBatch(retry.entries, { isCurrent: retry.isCurrent, withValidationScope });
        assert.equal(sourceChecks, 1);
        sourceChecks = 0;
        assert.equal(accepted.publish().status, 'published');
        assert.equal(sourceChecks, 1, 'a later valid publication performs a new shared scan');
        assert.equal(retry.finalize(), true);
        for (let i = 0; i < rows.length; i++) {
            assert.equal(f.root(buckets[i]), undefined);
            assert.equal(f.yAt(Infinity, i * 24), null);
            assert.equal(r.roadEntries.has(rows[i].featureKey), false);
        }
        assert.equal(f.registry.snapshot().pendingCount, 0);
    } finally { f.close(); }
});
