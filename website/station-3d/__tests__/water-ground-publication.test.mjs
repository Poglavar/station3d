// Actual water adapter, coast/quay factories, triangle clipping, civil queries
// and Rapier. Only material decoration, scene uniforms and GPU waits are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CivilGroundComposition, CIVIL_GROUND_AUTHORITY as A } from '../core/civil-ground-composition.js';
import * as coast from '../core/coastline-mask.js';
import { finiteOrNull } from '../core/math.js';
import { createCoastDressingBuildTask } from '../core/coast-dressing-build-task.js';
import { buildUrbanCoastGeometryData, createUrbanCoastLandingSampler, resolveUrbanCoastSection, splitLongCoastQuads, URBAN_COAST_SEARCH_M } from '../core/urban-coast-formation.js';
import { compileMappedWaterSurfaceSteps, captureMappedWaterOpeningsSteps, sameMappedWaterGeometrySteps } from '../core/mapped-water-ground.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { clipReceiverMeshOpeningsSteps } from '../core/receiver-mesh-openings.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION, compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { prepareFixedSurfacePublicationSteps } from '../core/fixed-surface-publication.js';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';
import { applyWorldXZWaterUvs, WATER_UV_PER_M } from '../world/water-material.js';

await RAPIER.init();
const source = readFileSync(new URL('../world/water.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = [
    between('function waterGroundFailure', '// Fetch water + pavement'),
    between('function coastCollarNear', '// Probe on the land edge'),
    between('function buildShoreTopIndex', 'function buildLandCollarGeometry'),
    between('function geometryFromCoastData', 'function createUrbanQuayStoneTexture'),
    between('function buildUrbanCoastFormationGroup', 'function cancelUrbanCoastBuild'),
    between('function urbanCoastQuadsNear', 'function scheduleUrbanCoastBuild'),
    between('function buildCoastDressingGroup', 'function cleanupCoastDressingBuild'),
].join('\n');
const drain = steps => { for (let i = 0; i < 100000; i++) { const n = steps.next(); if (n.done) return n.value; } assert.fail('unbounded'); };
const terrainClaim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };
function fixture({ centerX = 0, centerZ = 0, roadMesh = true, pedestrianZone = () => false } = {}) {
    const registry = createSurfacePublicationRegistry(), scene = new THREE.Scene();
    const civil = new CivilGroundComposition({ terrainSceneYAtLocal: () => 8, terrainEvidenceSceneYAtLocal: () => 8 });
    const rendered = createRenderedRoadSurfaceRegistry();
    if (roadMesh) rendered.replace('road', [{ drivable: true, positions: new Float32Array([-40+centerX,1,-40+centerZ, 40+centerX,1,40+centerZ, 40+centerX,1,-40+centerZ, -40+centerX,1,-40+centerZ, -40+centerX,1,40+centerZ, 40+centerX,1,40+centerZ]) }]);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }), active = new Map(), metadata = new Map();
    let revision = 0, colliderCount = 0, publishedOpenings = null, masks = 0, disposedMasks = 0, uploads = 0, disposedRoots = 0;
    const identity = material => material;
    const runtime = vm.createContext({ THREE, ...coast, finiteOrNull, createCoastDressingBuildTask,
        buildUrbanCoastGeometryData, createUrbanCoastLandingSampler, resolveUrbanCoastSection, splitLongCoastQuads, URBAN_COAST_SEARCH_M,
        pedestrianZoneAtLocal: pedestrianZone,
        compileMappedWaterSurfaceSteps, captureMappedWaterOpeningsSteps, sameMappedWaterGeometrySteps, captureReceiverMeshReadSteps,
        EMPTY_RECEIVER_SUPPORT_READ, clipReceiverMeshOpeningsSteps, GROUND_GENERATION_LIMITS,
        prepareTerrainCutoutTilesSteps, createTerrainCutoutTopologySteps, clipReceiverGeometrySteps,
        markSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION, compileSurfaceClaim,
        waterGroundContext: { civilGround: civil }, waterGroundSource: null, activeWaterGround: null, activeUrbanGround: null,
        activeCoastGround: null, waterWorldGroup: scene,
        releaseCoastTerrainReplacement: null, group: null, waterMaterials: [], activeSeaClaim: null,
        publishedSeaPlane: null, activeCoastline: null, mappedSeaReady: false, urbanCoastGroup: null, urbanCoastSceneYAtLocal: null,
        terrainReference: null, COAST_SURFACE_LIFT_M: .012, COAST_TERRAIN_MAX_REACH_M: 128,
        COAST_LAND_COLLAR_M: 4.5, COAST_MIN_COLLAR_M: 2, COAST_TERRAIN_INNER_OVERLAP_M: .75,
        FETCH_RADIUS_M: 1500, MASK_HALF_SIZE_M: 1600, WALL_TOP_Y: .02, WALL_BOTTOM_Y: -2.4,
        URBAN_COAST_RADIUS_M: 280, scene, renderer: { initTexture() {} }, camera: new THREE.PerspectiveCamera(),
        navigationMapContext: { setWater() {} }, replaceGroundMask() {},
        notifyMappedSeaListeners() {}, notifyUrbanCoastListeners() {}, markInspectionLayer() {},
        applySurfaceStencil: identity, applyGroundOwnership: identity, applyPlannerSurfaceCutout: identity,
        applyStreetLampSurfaceLighting: identity, applyWorldXZWaterUvs,
        createUrbanQuayStoneTexture: () => null, createWaterMaterial: () => new THREE.MeshBasicMaterial(),
        createCoastTerrainMaterial: () => new THREE.MeshBasicMaterial(),
        getActiveTerrainSurface: () => ({ uvPerM: 1 }), resolveMappedSeaSurfaceY: () => -1,
        buildMaskTexture() { masks++; const texture = new THREE.Texture(); texture.addEventListener('dispose', () => disposedMasks++); return texture; },
        disposeGroup(root) { disposedRoots++; root.removeFromParent(); root.traverse(mesh => { mesh.geometry?.dispose(); mesh.material?.dispose(); }); runtime.onRootDisposed?.(); },
        *prewarmDetachedObject() { uploads++; yield { phase: 'controlled-water-gpu', deferFrame: true, ready: runtime.testGpuReady }; },
    });
    vm.runInContext(code, runtime);
    runtime.waterGroundSource = Object.freeze({ center: Object.freeze({ x: centerX, z: centerZ }), seaY: -1,
        coastline: coast.createMappedCoastline([{ outer: [[-10+centerX,-10+centerZ],[10+centerX,-10+centerZ],[10+centerX,10+centerZ],[-10+centerX,10+centerZ],[-10+centerX,-10+centerZ]], holes: [] }]) });
    const prepare = (height = 1, extra = {}, terrainRevision = height, cutoutLayers = []) => {
        const generation = ++revision;
        const terrain = Object.freeze({ revision: terrainRevision, evidenceSceneYAtLocal: () => height });
        const resource = drain(runtime.prepareWaterGroundSteps({ terrain, registry, generation, isCurrent: () => true }));
        const openings = drain(createSurfaceOpeningReadSteps({ water: resource.water, ...extra, limits: GROUND_GENERATION_LIMITS.openings }));
        const coastCandidate = drain(resource.prepareOpeningReceiversSteps({ openings }));
        const urban = drain(resource.prepareRoadReceiversSteps({ roads: { *captureRoadSurfaceReadSteps(bounds, isCurrent) {
            return yield* rendered.captureReadSnapshotSteps(bounds, { maxOwners: 64, maxCells: 1024, maxCellParts: 2048, isCurrent });
        } }, openings, centerX, centerZ }));
        const coastReceiver = drain(resource.prepareTerrainReceiversSteps({ cutoutLayers, openings }));
        return { generation, resource, coastCandidate, coastReceiver, urban, openings };
    };
    const stage = (height, extra, terrainRevision, cutoutLayers) => {
        const next = prepare(height, extra, terrainRevision, cutoutLayers), oldOpenings = publishedOpenings;
        const surfaces = [...next.coastReceiver.supportRead.surfaces, ...next.urban.supportRead.surfaces];
        const data = buildCurbSurfaceTrimeshData({ surfaces, centerX, centerZ, radiusM: 256,
            physicsOrigin: { x: centerX, z: centerZ }, maxTriangles: 8192 });
        assert.equal(data.truncated, false);
        const physics = drain(prepareFixedSurfacePublicationSteps({ RAPIER, world, active, metadata,
            replacements: [{ key: 'water', spec: { id: 'water' }, meshes: data.triangleCount ? [{
                vertices: data.vertices, indices: data.indices,
                friction: .8, collisionGroups: 0xffffffff,
            }] : [] }], activeColliderCount: colliderCount, maxColliders: 16, maxStagedColliders: 16 }));
        const entries = [...next.coastCandidate.entries, ...next.urban.entries, ...next.coastReceiver.entries,
            { ticket: registry.begin({ key: 'openings', generation: next.generation }), clear: true,
                commit() { publishedOpenings = next.openings; return true; }, rollback() { publishedOpenings = oldOpenings; } },
            { ticket: registry.begin({ key: 'physics', generation: next.generation }), clear: true,
                commit: physics.promote, rollback: physics.rollback, discard: physics.dispose }];
        return { ...next, publish(fail = false) {
            const batch = registry.prepareBatch(entries, fail ? { commit() { throw Error('later member failed'); } } : {});
            assert.equal(batch.publish().status, 'published'); next.coastCandidate.finalize(); next.urban.finalize(); next.coastReceiver.finalize(); physics.retire();
            colliderCount = physics.nextColliderCount;
        }, discard() { next.coastCandidate.discard(); next.urban.discard(); next.coastReceiver.discard(); physics.dispose(); } };
    };
    return { runtime, registry, civil, prepare, stage, get uploads() { return uploads; }, get masks() { return masks; }, get disposedMasks() { return disposedMasks; },
        get disposedRoots() { return disposedRoots; },
        get openings() { return publishedOpenings; },
        floor(x, z) { world.step(); const hit = world.castRay(new RAPIER.Ray({ x: x-centerX, y: 20, z: z-centerZ }, { x: 0, y: -1, z: 0 }), 50, true); return hit ? 20-hit.timeOfImpact : null; },
        renderFloor(x, z) {
            scene.updateMatrixWorld(true);
            const physical = [];
            scene.traverse(mesh => { if (mesh.isMesh && mesh.userData.groundColliderFamily === 'authored-surfaces') physical.push(mesh); });
            return new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0,-1,0)).intersectObjects(physical, false)[0]?.point.y ?? null;
        },
        close() { registry.close(); runtime.activeWaterGround?.mask?.dispose(); rendered.clear(); world.free(); } };
}
for (const outcome of ['publish', 'rollback', 'cancel']) test(`sea, coast, civil inputs and actual colliders ${outcome} together`, () => {
    const f = fixture();
    try {
        f.stage(1).publish();
        const oldRoot = f.runtime.group, oldOpenings = f.openings, oldCivilRevision = f.civil.registrationRevision;
        const priorY = f.floor(13, 0), priorInput = f.civil.inputSceneYAtLocal(A.ROAD, 13, 0);
        assert.ok(Number.isFinite(priorY)); assert.equal(f.floor(0, 0), null, 'water itself is not a walking floor');
        const next = f.stage(3);
        assert.equal(f.runtime.group, oldRoot); assert.equal(f.openings, oldOpenings); assert.equal(f.floor(13, 0), priorY);
        assert.equal(f.civil.inputSceneYAtLocal(A.ROAD, 13, 0), priorInput);
        assert.notEqual(next.coastCandidate.terrainReplacement.sampleSceneYAtLocal(13, 0), priorInput);
        if (outcome === 'publish') next.publish();
        else if (outcome === 'rollback') assert.throws(() => next.publish(true), /later member/);
        else next.discard();
        if (outcome === 'publish') assert.ok(f.floor(13,0) > priorY);
        else {
            assert.equal(f.runtime.group, oldRoot); assert.equal(f.openings, oldOpenings); assert.equal(f.floor(13,0), priorY);
            assert.equal(f.civil.registrationRevision, oldCivilRevision);
        }
        const uploads = f.uploads, masks = f.masks;
        const retained = f.prepare(outcome === 'publish' ? 3 : 1);
        assert.equal(retained.coastCandidate.entries.length, 0); assert.equal(retained.urban.entries.length, 0);
        assert.equal(retained.coastReceiver.entries.length, 0);
        assert.equal(f.uploads, uploads); assert.equal(f.masks, masks, 'unchanged water allocates no new mask');
        f.runtime.waterGroundSource = Object.freeze({ center: { x: 0, z: 0 }, seaY: -1, coastline: coast.createMappedCoastline([]) });
        f.stage(5).publish();
        assert.equal(f.runtime.group, null); assert.equal(f.runtime.urbanCoastGroup, null); assert.equal(f.floor(13, 0), null);
        assert.equal(f.runtime.activeCoastGround.root, null);
        assert.equal(f.openings.empty, true); assert.equal(f.civil.inputSceneYAtLocal(A.ROAD, 13, 0), 8);
        assert.equal(f.disposedMasks, f.masks);
    } finally { f.close(); }
});

test('a newer coastline source queues a successor without invalidating the captured water generation', () => {
    const f = fixture();
    try {
        const terrain = Object.freeze({ revision: 1, evidenceSceneYAtLocal: () => 1 });
        const resource = drain(f.runtime.prepareWaterGroundSteps({ terrain, registry: f.registry,
            generation: 1, isCurrent: () => true }));
        f.runtime.waterGroundSource = Object.freeze({ center: Object.freeze({ x: 500, z: 0 }), seaY: -1,
            coastline: coast.createMappedCoastline([]) });
        assert.equal(resource.isCurrent(), true,
            'the admitted immutable source remains publishable while its successor is pending');
    } finally { f.close(); }
});

for (const center of [0, 100000.321]) test(`coastal support and meshes share authored openings at ${center}`, () => {
    const f = fixture({ centerX: center, centerZ: -center });
    const x = center+13, z = -center;
    try {
        f.stage(1).publish(); assert.ok(Number.isFinite(f.floor(x, z)));
        assert.ok(Math.abs(f.renderFloor(x,z)-f.floor(x,z)) < .001);
        const opening = { ring: [{x:x-1,z:z-2},{x:x+1,z:z-2},{x:x+1,z:z+2},{x:x-1,z:z+2}], minY: -2, maxY: 3, replacementKey: 'authored-tunnel' };
        f.stage(1, { authored: [opening] }).publish();
        assert.equal(f.floor(x, z), null); assert.equal(f.renderFloor(x,z), null);
        assert.equal(f.civil.inputSceneYAtLocal(A.ROAD, x, z), 8);
        assert.ok(Number.isFinite(f.renderFloor(x, z+3)));
        assert.ok(Math.abs(f.renderFloor(x,z+3)-f.floor(x,z+3)) < .001);
        const meshes = []; f.runtime.group.traverse(mesh => { if (mesh.isMesh) meshes.push(mesh); });
        assert.ok(meshes.every(mesh => mesh.material.defines.ST3D_PLANNER_GEOMETRY_CUTOUTS === 1));
        assert.equal(f.openings.contains(center, 0, -center, terrainClaim), true);
        assert.equal(f.openings.contains(center, -1.1, -center, terrainClaim), false);
    } finally { f.close(); }
});

test('a terrain revision without changed coastal faces retains geometry, masks, support and civil registration', () => {
    const f = fixture();
    try {
        f.stage(1).publish();
        const root = f.runtime.group, support = f.runtime.activeWaterGround.supportRead, revision = f.civil.registrationRevision;
        const uploads = f.uploads, masks = f.masks;
        const next = f.stage(1, {}, 99);
        assert.equal(next.coastCandidate.changedBounds.length, 0);
        next.publish();
        assert.equal(f.runtime.group, root); assert.equal(f.runtime.activeWaterGround.supportRead, support);
        assert.equal(f.runtime.activeWaterGround.data.terrainRevision, 99);
        assert.equal(f.uploads, uploads); assert.equal(f.masks, masks); assert.equal(f.civil.registrationRevision, revision);
    } finally { f.close(); }
});

test('road and rail earthworks cut the coast receiver without changing the construction ground beneath them', () => {
    const f = fixture();
    try {
        f.stage(3).publish();
        const input = f.civil.inputSceneYAtLocal(A.ROAD, 13, 0);
        assert.ok(Number.isFinite(f.floor(13, 0)));
        const region = { ring: [{x:12,z:-1},{x:14,z:-1},{x:14,z:1},{x:12,z:1}],
            bounds: {minX:12,minZ:-1,maxX:14,maxZ:1}, minY:-2, maxY:3 };
        const next = f.stage(3, {}, 3, [{ operation: 'subtract', regions: [region] }]);
        assert.ok(Number.isFinite(f.floor(13,0)), 'the published coast survives all preparation');
        assert.equal(next.coastCandidate.entries.length, 0, 'construction and sea need no replacement');
        next.publish();
        assert.equal(f.floor(13,0), null, 'removed coastal triangles provide no ghost collider');
        assert.equal(f.civil.inputSceneYAtLocal(A.ROAD,13,0), input, 'road construction does not consume its own cut');
        assert.ok(Number.isFinite(f.floor(13,2)), 'neighbouring coast remains physical');
    } finally { f.close(); }
});

for (const center of [4096.321, 16000.321, -100000.321]) test(`translated centre ${center} preserves earthwork coast cut and neighbouring support`, () => {
    const f = fixture({ centerX: center, centerZ: center });
    try {
        f.stage(3).publish();
        for (const root of [f.runtime.group, f.runtime.activeCoastGround.root, f.runtime.urbanCoastGroup]) root?.traverse(mesh => {
            const p = mesh.geometry?.attributes.position;
            for (let i=0; i<(p?.count || 0); i++) assert.ok(Math.max(Math.abs(p.getX(i)), Math.abs(p.getZ(i))) < 1600,
                'GPU positions remain local to the water window');
        });
        const sea = f.runtime.group.getObjectByName('SeaWaterSurface');
        const p = sea.geometry.attributes.position, uv = sea.geometry.attributes.uv;
        for (let i=0; i<p.count; i++) {
            assert.equal(uv.getX(i), Math.fround((p.getX(i)+center)*WATER_UV_PER_M));
            assert.equal(uv.getY(i), Math.fround((p.getZ(i)+center)*WATER_UV_PER_M));
        }
        const x = center + 13, z = center;
        const input = f.civil.inputSceneYAtLocal(A.ROAD, x, z);
        assert.ok(Number.isFinite(f.floor(x, z)));
        const region = { ring: [{x:x-1,z:z-1},{x:x+1,z:z-1},{x:x+1,z:z+1},{x:x-1,z:z+1}],
            bounds: {minX:x-1,minZ:z-1,maxX:x+1,maxZ:z+1}, minY:-2, maxY:3 };
        const next = f.stage(3, {}, 3, [{ operation: 'subtract', regions: [region] }]);
        assert.ok(Number.isFinite(f.floor(x, z)));
        next.publish();
        assert.equal(f.floor(x, z), null);
        assert.equal(f.renderFloor(x,z), null);
        assert.equal(f.civil.inputSceneYAtLocal(A.ROAD,x,z), input);
        assert.ok(Number.isFinite(f.floor(x, z + 2)));
        assert.ok(Math.abs(f.floor(x,z+2)-f.renderFloor(x,z+2)) < .001);
    } finally { f.close(); }
});

test('cancelling during GPU preparation retires the private root only after its outstanding fence', async () => {
    const f = fixture();
    let ready;
    try {
        f.stage(1).publish(); const root = f.runtime.group;
        f.runtime.testGpuReady = new Promise(resolve => { ready = resolve; });
        const resource = drain(f.runtime.prepareWaterGroundSteps({ terrain: Object.freeze({ revision: 3, evidenceSceneYAtLocal: () => 3 }),
            registry: f.registry, generation: 100, isCurrent: () => true }));
        const openings = drain(createSurfaceOpeningReadSteps({ water: resource.water, limits: GROUND_GENERATION_LIMITS.openings }));
        const steps = resource.prepareOpeningReceiversSteps({ openings });
        for (let i = 0; i < 10000; i++) { const next = steps.next(); assert.equal(next.done, false); if (next.value?.ready) break; }
        const disposed = f.disposedRoots;
        steps.return(); assert.equal(f.disposedRoots, disposed); assert.equal(f.runtime.group, root);
        const retired = new Promise(resolve => { f.runtime.onRootDisposed = resolve; });
        ready(); await retired;
        assert.equal(f.disposedRoots, disposed + 1); steps.return(); assert.equal(f.disposedRoots, disposed + 1);
    } finally { ready?.(); f.close(); }
});

test('a painted promenade with no road mesh still forms a quay on terrain evidence', () => {
    // Since receiver paving, promenades are paint on the terrain: the rendered
    // road registry is empty at Split's Riva, yet the walker stands on paving
    // 0.7 m above the sea. That is a quay wall, not a sloping collar.
    const painted = fixture({ roadMesh: false, pedestrianZone: () => true });
    try {
        painted.stage(-0.3).publish();
        const quay = painted.runtime.urbanCoastGroup;
        assert.ok(quay, 'painted pedestrian ground is a firm landing');
        assert.ok(quay.userData.sectionCount > 0);
        // The deck rests on the terrain evidence with the collar's own lift.
        const deckY = painted.renderFloor(13, 0);
        assert.ok(Math.abs(deckY - (-0.3 + 0.012)) < 1e-6, `deck at ${deckY}`);
        assert.ok(Math.abs(painted.floor(13, 0) - deckY) < 0.02, 'physics follows the deck');
    } finally { painted.close(); }
    // The same shore with bare ground keeps the collar: paving is the evidence.
    const bare = fixture({ roadMesh: false, pedestrianZone: () => false });
    try {
        bare.stage(-0.3).publish();
        assert.equal(bare.runtime.urbanCoastGroup, null);
    } finally { bare.close(); }
});
