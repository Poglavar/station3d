// Real-API integration boundary for one terrain/road generation. This is a
// deterministic headless transaction test, not live-world or GPU acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { compileTerrainRenderPacket } from '../core/compilers/terrain-render-packet.js';
import { RoadFormationModel, refineTriangulatedSurface } from '../core/road-formation.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { prepareFixedSurfacePublication } from '../core/fixed-surface-publication.js';
import { drapeEdgeMForTriangulation } from '../core/proposal-ground.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';

await RAPIER.init();
const tileM = 40, lat = 45.8, lon = 16;
const scale = DEG_TO_RAD * EARTH_RADIUS_M;
const lonScale = scale * Math.cos(lat * DEG_TO_RAD);
const limits = { tileM, maxTiles: 4, maxChangedTiles: 4, maxSnapshots: 4, maxReadSnapshots: 4, maxSourceBytes: 100000, maxReceiverBytes: 1000000, maxSegments: 20 };
const drain = iterator => { for (;;) { const step = iterator.next(); if (step.done) return step.value; } };
function source(height) {
    const resolution = 2, min = -20, max = 60, side = (max - min) / resolution + 1;
    const values = new Uint16Array(side * side);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) values[z * side + x] = Math.round(height * 100);
    const grid = { width: side, height: side, bounds: { west: lon + (min - 1) / lonScale, east: lon + (max + 1) / lonScale, north: lat - (min - 1) / scale, south: lat - (max + 1) / scale } };
    return new TerrainGrid({ grid, encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } }, values.buffer);
}
function terrainRow(snapshot, height) {
    const request = { sourceRevision: `fixture:${snapshot.revision}`, generation: 1,
        tile: { matrix: 'station3d-local-metre-v1', z: 0, x: 0, y: 0,
            originLon: lon, originLat: lat, sizeM: tileM },
        inputs: { snapshotRevision: snapshot.revision, tileX: 0, tileZ: 0, tileM, segments: 20, uvPerM: .1 } };
    const primitive = compileTerrainRenderPacket(request, snapshot).primitives[0];
    return { snapshot, tileX: 0, tileZ: 0, segments: 20, positions: primitive.positions, indices: primitive.indices };
}

// Run the production road builder with poisoned live globals. Its independent
// rectangular road polygon cannot accidentally masquerade as a terrain packet.
function roadGeometry(ground) {
    const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    const live = new Proxy({}, { get() { throw new Error('live ground query'); } });
    const runtime = vm.createContext({ THREE, finiteOrNull, refineTriangulatedSurface, isPermanentTerrainGap,
        drapeEdgeMForTriangulation, startupTrace: { enabled: false }, profNow: () => 0, profAdd() {},
        terrainReference: live, roadFormationModel: live, roadVerticalAlignmentModel: live });
    const constants = [...source.matchAll(/^const (?:ENGINEERED_SURFACE_MAX_\w+|DRAPED_SURFACE_MAX_\w+|VERTICAL_ALIGNMENT_SURFACE_MAX_\w+|ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP) = [^;]+;/gm)]
        .map(match => match[0]).join('\n');
    vm.runInContext(constants + '\nconst ASPHALT_UV_PER_M = 1 / 16;\n'
        + source.slice(source.indexOf('function applyWorldRoadUvs('), source.indexOf('// Aggregated per-sub-step timing'))
        + source.slice(source.indexOf('function createTerrainConformingRoadGeometryTask('),
            source.indexOf('function createRoadPolygonGeometryTask(')), runtime);
    const seed = new THREE.PlaneGeometry(24, 6); seed.translate(20, 20, 0);
    const task = runtime.createTerrainConformingRoadGeometryTask(seed, .08, 1,
        true, false, null, false, false, ground);
    for (let i = 0; i < 10000; i++) {
        const status = task.step();
        if (status === 'done') return task.geometry();
        assert.equal(status, 'more');
    }
    throw new Error('Road geometry did not converge');
}
const near = (actual, expected, label) => assert.ok(Number.isFinite(actual)
    && Math.abs(actual - expected) <= .001, `${label}: ${actual} != ${expected} within 1 mm`);
function terrainGeometry(row) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(row.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(row.indices, 1)); return geometry;
}

test('terrain, production road geometry and Rapier retain old support on failure and promote one generation', () => {
    const raw = new TerrainReference(source(100), lon, lat, { surfaceStepM: 2 });
    const oldSource = captureGroundReadSnapshot(raw), oldRow = terrainRow(oldSource);
    const terrain = createPublishedTerrainReference(oldSource, limits);
    const initialTerrain = drain(terrain.prepareSteps([oldRow]));
    assert.equal(initialTerrain.commit(), true); assert.equal(initialTerrain.notify(), true);
    const oldLease = terrain.captureReadSnapshot('initial-road');
    let selectedRead = oldLease;
    function* capture() {
        const read = selectedRead;
        return { context: Object.freeze({ terrain: read }), callbacks: {
            baseSceneYAtLocal: read.sceneYAtLocal, baseTerrainReplacementAtLocal: () => false,
            terrainEvidenceSceneYAtLocal: read.evidenceSceneYAtLocal,
            sourceTerrainInputSceneYAtLocal: read.sceneYAtLocal, sourceTerrainOwnsInputAtLocal: () => true,
        }, isCurrent: () => selectedRead === read };
    }
    const model = new RoadFormationModel({ anchorLat: lat, anchorLon: lon,
        baseSceneYAtLocal: oldLease.sceneYAtLocal, captureBuildInputsSteps: capture });
    const ll = ([x, z]) => [lon + x / lonScale, lat - z / scale];
    model.setCenterlineTile('0_0', [{ properties: { osm_id: 1, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[8, 20], [32, 20]].map(ll) } }]);
    model.setSurfaceTile('0_0', [{ properties: { osm_id: 1, highway_type: 'residential' },
        geometry: { type: 'Polygon', coordinates: [[[8, 17], [32, 17], [32, 23], [8, 23], [8, 17]].map(ll)] } }]);
    const initialRoad = drain(model.preparePublicationSteps());
    assert.equal(initialRoad.commit(), true); assert.equal(initialRoad.finalize(), true);
    const scene = new THREE.Scene(), registry = createSurfacePublicationRegistry();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }), active = new Map(), metadata = new Map();
    let created = 0, disposed = 0, acceptedLease = null;
    const mesh = (geometry, surfaceClass, generation) => {
        const root = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        const key = surfaceClass === SURFACE_CLASS.ROAD_CARRIAGEWAY ? 'road' : 'terrain';
        markSurfaceClaim(root, { surfaceClass, ownerId: key, replacementKey: key,
            generation, verticalBand: 'ground', supportReady: true });
        let retired = false;
        root.userData.retire = () => {
            assert.equal(retired, false, 'each root is disposed once'); retired = true;
            root.removeFromParent(); geometry.dispose(); root.material.dispose(); disposed++;
        };
        created++; return root;
    };
    const retire = (_context, root) => root.userData.retire();
    const ticket = (key, generation) => registry.begin({ key, generation, parent: scene, retire });
    const physicsFor = roots => prepareFixedSurfacePublication({ RAPIER, world, active, metadata,
        replacements: roots.map(([key, root]) => ({ key, spec: { id: key }, meshes: [{
            vertices: root.geometry.attributes.position.array, indices: root.geometry.index.array,
            friction: 1, collisionGroups: 0xffffffff,
        }] })), activeColliderCount: metadata.size, maxColliders: 2, maxStagedColliders: 2 });
    const ray = new THREE.Raycaster(new THREE.Vector3(20, 10, 20), new THREE.Vector3(0, -1, 0));
    const renderY = root => { root.updateMatrixWorld(true); return ray.intersectObject(root)[0]?.point.y; };
    const support = () => {
        world.step();
        const hit = world.castRay(new RAPIER.Ray({ x: 20, y: 10, z: 20 }, { x: 0, y: -1, z: 0 }), 20, true);
        assert.ok(hit, 'real collider supports road centre');
        return { y: 10 - hit.timeOfImpact, handle: hit.collider.handle };
    };
    const oldTerrainRoot = mesh(terrainGeometry(oldRow), SURFACE_CLASS.TERRAIN, 1);
    const oldRoadRoot = mesh(roadGeometry({ terrain: oldLease, roadFormation: initialRoad.read }), SURFACE_CLASS.ROAD_CARRIAGEWAY, 1);
    ticket('terrain', 1).publish(oldTerrainRoot); ticket('road', 1).publish(oldRoadRoot);
    const initialPhysics = physicsFor([['terrain', oldTerrainRoot], ['road', oldRoadRoot]]);
    assert.equal(initialPhysics.promote(), true); assert.deepEqual(initialPhysics.retire(), []);
    const oldSupport = support(), oldInputs = model.getPublishedBuildInputs(), oldCollider = active.get('road');
    near(oldSupport.y, .08, 'initial support'); near(renderY(oldRoadRoot), .08, 'initial rendered road');
    const observations = [];
    registry.subscribe(() => observations.push({ terrain: terrain.sceneYAtLocal(20, 20),
        road: model.sceneYAtLocal(20, 20, { osmId: 1 }),
        rendered: renderY(registry.getActive('road').root), support: support(), roots: scene.children.length }));
    raw.replaceGrid(source(101));
    const nextSource = captureGroundReadSnapshot(raw), nextRow = terrainRow(nextSource);
    const assertOld = () => {
        near(terrain.sceneYAtLocal(20, 20), 0, 'old terrain');
        near(model.sceneYAtLocal(20, 20, { osmId: 1 }), 0, 'old road query');
        assert.equal(model.getPublishedBuildInputs(), oldInputs);
        assert.equal(registry.getActive('terrain').root, oldTerrainRoot);
        assert.equal(registry.getActive('road').root, oldRoadRoot);
        assert.equal(active.get('road'), oldCollider);
    };
    try {
        for (const failure of [true, false]) {
            const generation = failure ? 2 : 3;
            const terrainTx = drain(terrain.prepareSteps([nextRow])); assertOld();
            const lease = terrainTx.captureReadSnapshot(`road-${generation}`); selectedRead = lease;
            near(lease.sceneYAtLocal(20, 20), 1, 'candidate terrain'); model.invalidateTerrain();
            const steps = model.preparePublicationSteps(); let roadTx;
            for (let i = 0; i < 20000; i++) {
                const next = steps.next(); assertOld();
                if (next.done) { roadTx = next.value; break; }
            }
            assert.ok(roadTx, 'road preparation converges');
            near(roadTx.read.sceneYAtLocal(20, 20, { osmId: 1 }), 1, 'candidate road query');
            const terrainRoot = mesh(terrainGeometry(nextRow), SURFACE_CLASS.TERRAIN, generation);
            const roadRoot = mesh(roadGeometry({ terrain: lease, roadFormation: roadTx.read }), SURFACE_CLASS.ROAD_CARRIAGEWAY, generation);
            near(renderY(roadRoot), 1.08, 'candidate rendered road');
            const physics = physicsFor([['terrain', terrainRoot], ['road', roadRoot]]);
            assert.equal(world.colliders.len(), 4, 'old and disabled staged support coexist');
            assert.deepEqual(support(), oldSupport, 'staging does not expose candidate support');
            assert.equal(terrain.usage().readSnapshots, 2);
            const batch = registry.prepareBatch([
                { ticket: ticket('terrain', generation), root: terrainRoot, isCurrent: terrainTx.isCurrent,
                    commit: terrainTx.commit, rollback: terrainTx.rollback,
                    discard(context, root) { retire(context, root); terrainTx.discard(); } },
                { ticket: ticket('road', generation), root: roadRoot, isCurrent: roadTx.isCurrent,
                    commit: roadTx.commit, rollback: roadTx.rollback,
                    discard(context, root) { retire(context, root); roadTx.discard(); lease.release(); } },
                { ticket: registry.begin({ key: 'physics', generation }), clear: true,
                    commit: physics.promote, rollback: physics.rollback, discard: () => physics.dispose() },
            ], { commit() { if (failure) throw new Error('injected after physics promotion'); } });
            assertOld();
            if (failure) {
                assert.throws(() => batch.publish(), /injected after physics promotion/);
                assertOld(); assert.deepEqual(scene.children, [oldTerrainRoot, oldRoadRoot]);
                assert.deepEqual(support(), oldSupport, 'rollback restores collider identity and height');
                assert.equal(world.colliders.len(), 2); assert.equal(metadata.size, 2);
                assert.equal(observations.length, 0); assert.equal(terrain.usage().readSnapshots, 1);
                assert.throws(() => lease.sceneYAtLocal(20, 20), { code: 'terrain-read-released' });
                selectedRead = oldLease;
            } else {
                assert.equal(batch.publish().status, 'published');
                assert.equal(roadTx.finalize(), true); assert.deepEqual(physics.retire(), []);
                assert.equal(terrainTx.notify(), true);
                assert.equal(oldLease.release(), true); acceptedLease = lease;
                assert.deepEqual(scene.children, [terrainRoot, roadRoot]);
                near(terrain.sceneYAtLocal(20, 20), 1, 'published terrain query');
                near(renderY(terrainRoot), 1, 'published terrain mesh');
                near(model.sceneYAtLocal(20, 20, { osmId: 1 }), 1, 'published road query');
                near(renderY(roadRoot), 1.08, 'published road mesh'); near(support().y, 1.08, 'published support');
                assert.notEqual(support().handle, oldSupport.handle);
                assert.equal(world.colliders.len(), 2); assert.equal(metadata.size, 2);
                assert.equal(terrain.usage().readSnapshots, 1); assert.equal(observations.length, 3);
                for (const observed of observations) {
                    near(observed.terrain, 1, 'observer terrain'); near(observed.road, 1, 'observer road');
                    near(observed.rendered, 1.08, 'observer rendered road'); near(observed.support.y, 1.08, 'observer support');
                    assert.equal(observed.roots, 2);
                }
            }
        }
    } finally {
        registry.close({ retireActive: true });
        for (const entry of active.values()) if (entry.body) world.removeRigidBody(entry.body);
        active.clear(); metadata.clear();
        assert.equal(world.colliders.len(), 0); assert.equal(world.bodies.len(), 0); world.free();
        model.clear(); acceptedLease?.release(); oldLease.release(); terrain.close();
        assert.equal(scene.children.length, 0); assert.equal(created, disposed);
        assert.equal(terrain.usage().residentSourceBytes, 0);
    }
});
