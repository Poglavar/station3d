import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureGroundReadSnapshot, captureTerrainReadSnapshot, serializeTerrainSnapshotSteps, deserializeTerrainReference } from '../core/terrain-snapshot.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { compileTerrainRenderPacket } from '../core/compilers/terrain-render-packet.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { buildTerrainReceiverSupportSteps } from '../core/terrain-receiver-support.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { prepareFixedSurfacePublication } from '../core/fixed-surface-publication.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { projectReceiverDetailSteps } from '../core/receiver-detail-projection.js';

await RAPIER.init();
const tileM = 40, lat = 45.8, lon = 16;
const latScale = DEG_TO_RAD * EARTH_RADIUS_M, lonScale = latScale * Math.cos(lat * DEG_TO_RAD);
const limits = { tileM, maxTiles: 12, maxChangedTiles: 12, maxSnapshots: 6, maxReadSnapshots: 8, maxSourceBytes: 100000, maxReceiverBytes: 1000000, maxSegments: 20 };
function makeGrid(heightAt = () => 100) {
    const resolution = 2, min = -50, max = 150, side = (max - min) / resolution + 1;
    const values = new Uint16Array(side * side);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
        const value = heightAt(min + x * resolution, min + z * resolution);
        values[z * side + x] = value == null ? 65535 : Math.round(value * 100);
    }
    return new TerrainGrid({
        grid: { width: side, height: side, bounds: {
            west: lon + (min - resolution / 2) / lonScale, east: lon + (max + resolution / 2) / lonScale,
            north: lat - (min - resolution / 2) / latScale, south: lat - (max + resolution / 2) / latScale,
        } }, encoding: { scaleM: 0.01, offsetM: 0, noDataValue: 65535 },
    }, values.buffer);
}
function reference(heightAt, options = {}) {
    return new TerrainReference(makeGrid(heightAt), lon, lat, { surfaceStepM: 20, ...options });
}
function drain(iterator, onStep = () => {}) {
    for (;;) { const step = iterator.next(); onStep(step); if (step.done) return step.value; }
}
function tile(snapshot, tileX = 0, tileZ = 0) {
    const segments = tileM / snapshot.sampleStepMAtLocal((tileX + 0.5) * tileM, (tileZ + 0.5) * tileM);
    const request = { sourceRevision: `fixture:${snapshot.revision}`, generation: 1,
        tile: { matrix: 'station3d-local-metre-v1', z: 0, x: tileX, y: tileZ,
            originLon: lon + tileX * tileM / lonScale, originLat: lat - tileZ * tileM / latScale, sizeM: tileM },
        inputs: { snapshotRevision: snapshot.revision, tileX, tileZ, tileM, segments, uvPerM: 0.1 } };
    const primitive = compileTerrainRenderPacket(request, snapshot).primitives[0];
    return { snapshot, tileX, tileZ, segments, positions: primitive.positions, indices: primitive.indices };
}
function publish(view, rows, options) {
    const tx = drain(view.prepareSteps(rows, options));
    assert.equal(tx.commit(), true); assert.equal(tx.notify(), true);
    return tx;
}

test('read-only terrain participants preserve revision, roots and notifications while holding their successor slot', () => {
    const snapshot = captureTerrainReadSnapshot(reference()), view = createPublishedTerrainReference(snapshot, limits);
    publish(view, [tile(snapshot)]);
    const root = view.getTile(0, 0), revision = view.revision, events = [];
    view.onChange(event => events.push(event));
    const tx = drain(view.prepareSteps([])), held = tx.captureReadSnapshot('no-change-physics');
    assert.throws(() => drain(view.prepareSteps([tile(snapshot)])), { code: 'terrain-publication-pending' });
    assert.equal(tx.commit(), true); assert.equal(tx.rollback(), true);
    assert.equal(view.getTile(0, 0), root); assert.equal(view.revision, revision);
    assert.equal(tx.commit(), true); assert.equal(tx.notify(), true);
    assert.deepEqual(events, []); assert.equal(view.revision, revision);
    assert.equal(held.evidenceSceneYAtLocal(1, 1), view.evidenceSceneYAtLocal(1, 1));
    const retry = drain(view.prepareSteps([])); assert.equal(retry.discard(), true);
    held.release(); view.close(); assert.equal(view.usage().readSnapshots, 0);
});

test('point queries include Float32 lattice-edge rounding and match independent rendered triangles', () => {
    const snapshot = captureTerrainReadSnapshot(reference((x, z) => 100 + .01 * x + .005 * z,
        { surfaceStepM: 40 / 110 }));
    const row = tile(snapshot), view = createPublishedTerrainReference(snapshot, { ...limits, maxSegments: 128 });
    publish(view, [row]);
    for (const index of [1, 31, 55, 109]) {
        const storedX = row.positions[index * 3], intended = index * 40 / 110;
        const x = (storedX + intended) / 2, z = 13.37;
        const expected = sampleTriangles(row, x, z), actual = view.evidenceSceneYAtLocal(x, z);
        assert.ok(Number.isFinite(expected) && Number.isFinite(actual));
        assert.ok(Math.abs(actual - expected) < 1e-10);
        const storedZ = row.positions[index * 111 * 3 + 2];
        const roundedZ = (storedZ + intended) / 2;
        assert.ok(Math.abs(view.evidenceSceneYAtLocal(z, roundedZ) - sampleTriangles(row, z, roundedZ)) < 1e-10);
    }
    view.close();
});

test('published and retained receivers preserve exact openings, rollback and geometry residency', () => {
    const snapshot = captureTerrainReadSnapshot(reference((x,z) => 100 + x*z*.001));
    const old = tile(snapshot), replacement = tile(snapshot);
    const topology = drain(createTerrainCutoutTopologySteps({
        layers: [{operation:'subtract',regions:[{ring:[{x:.8,z:.8},{x:1.2,z:.8},{x:1.2,z:1.2},{x:.8,z:1.2}]}]}],
        limits:{maxSources:8,maxSourceVertices:64,maxIndexEntries:256,maxCellCandidates:8,
            maxOperandVertices:64,maxIntersections:32,maxOutputTriangles:64},
    }));
    replacement.receiver = drain(clipReceiverGeometrySteps({geometry:replacement,topology,maxVertices:128,maxTriangles:128}));
    const bytes = receiver => [...new Set([receiver.positions.buffer,receiver.indices.buffer,receiver.sourceTriangleOffsets?.buffer].filter(Boolean))]
        .reduce((sum,buffer)=>sum+buffer.byteLength,0);
    const oldBytes=bytes(old),cutBytes=bytes(replacement.receiver);
    const view=createPublishedTerrainReference(snapshot,{...limits,maxReceiverBytes:oldBytes+cutBytes});
    const bounds={minX:0,minZ:0,maxX:40,maxZ:40};
    assert.equal(view.receiverTilesForBounds(bounds),null,'unpublished data is not an empty opening');
    publish(view,[old]);
    const held=view.captureReadSnapshot('retained-uncut-support');
    const oldReceiver=view.getTile(0,0).receiver;
    const tx=drain(view.prepareSteps([replacement]),()=>assert.equal(view.getTile(0,0).receiver,oldReceiver));
    const next=tx.captureReadSnapshot('candidate-cut-support');
    assert.equal(next.receiverSceneYAtLocal(1, 1), null);
    const detail = read => drain(projectReceiverDetailSteps({ vertices: [
        .9, 0, .9, 1.1, 0, .9, 1.1, 0, 1.1,
        .9, 0, .9, 1.1, 0, 1.1, .9, 0, 1.1,
    ], receiverTriangles: bounds => read.receiverTrianglesInBounds(bounds) }));
    assert.ok(detail(held).positions.length > 0);
    assert.equal(detail(next).positions.length, 0, 'detail consumes the actual clipped candidate faces');
    assert.equal(next.evidenceSceneYAtLocal(1, 1), null, 'known source elevation cannot support an opening');
    assert.equal(next.sourceEvidenceSceneYAtLocal(1, 1), snapshot.evidenceSceneYAtLocal(1, 1));
    assert.ok(Number.isFinite(view.evidenceSceneYAtLocal(1, 1)), 'the old visible receiver still supplies support');
    const support=drain(buildTerrainReceiverSupportSteps({tiles:next.receiverTilesForBounds(bounds),bounds,
        limits:{maxTiles:4,maxSourceCells:16,maxTriangles:128,maxMeshes:64,maxTrianglesPerMesh:3}}));
    const world=new RAPIER.World({x:0,y:-9.81,z:0});
    for(const mesh of support.meshes)world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices,mesh.indices));
    world.step();
    assert.equal(world.castRay(new RAPIER.Ray({x:1,y:20,z:1},{x:0,y:-1,z:0}),100,true),null);
    const hit=world.castRay(new RAPIER.Ray({x:3,y:20,z:3},{x:0,y:-1,z:0}),100,true);
    assert.ok(hit);assert.ok(Math.abs(20-hit.timeOfImpact-snapshot.sceneYAtLocal(3,3))<.001);
    assert.equal(tx.commit(),true);assert.equal(tx.rollback(),true);
    assert.equal(view.getTile(0,0).receiver,oldReceiver);
    assert.ok(Number.isFinite(view.evidenceSceneYAtLocal(1, 1)), 'rollback restores point support');
    assert.equal(tx.commit(),true);assert.equal(tx.notify(),true);
    assert.equal(held.receiverTilesForBounds(bounds)[0].receiver,oldReceiver);
    assert.equal(view.evidenceSceneYAtLocal(1, 1), null);
    assert.ok(Number.isFinite(held.evidenceSceneYAtLocal(1, 1)), 'retained readers keep the previous physical surface');
    assert.ok(detail(held).positions.length > 0, 'retained detail reads keep the same geometry generation');
    assert.equal(detail(view).positions.length, 0);
    assert.equal(view.usage().residentReceiverBytes,oldBytes+cutBytes);
    next.release();
    const third=tile(snapshot);
    assert.throws(()=>drain(view.prepareSteps([third])),{code:'terrain-publication-capacity'});
    held.release();assert.equal(view.usage().residentReceiverBytes,cutBytes);
    publish(view,[third]);assert.equal(view.usage().residentReceiverBytes,bytes(third));
    assert.equal(view.receiverTilesForBounds({...bounds,maxX:41}),null);
    view.close();world.free();assert.equal(view.usage().residentReceiverBytes,0);
});

test('a clipped receiver must stay on its source face and carry a valid cell index',()=>{
    const snapshot=captureTerrainReadSnapshot(reference()),row=tile(snapshot);
    const view=createPublishedTerrainReference(snapshot,limits);
    const offsets=Uint32Array.from({length:row.indices.length/3+1},(_,i)=>i*3);
    row.receiver={positions:row.positions.slice(),indices:row.indices.slice(),sourceTriangleOffsets:offsets};
    row.receiver.positions[1]+=.01;
    assert.throws(()=>drain(view.prepareSteps([row])),{code:'terrain-publication-mesh-query'});
    row.receiver.positions[1]-=.01;
    row.receiver.sourceTriangleOffsets[1]=1;
    assert.throws(()=>drain(view.prepareSteps([row])),{code:'terrain-publication-receiver'});
    view.close();
});

test('raw and retained published readers report compatible lattices over the complete footprint', () => {
    const fine = stepM => reference(() => 100, { detail: { stepM, tileM,
        rects: [{ minX: 0, maxX: tileM, minZ: 0, maxZ: tileM }] } });
    const raw = fine(8), snapshot = captureTerrainReadSnapshot(raw);
    const inside = { minX: 1, maxX: 39, minZ: 1, maxZ: 39 };
    const crossing = { ...inside, maxX: 60 };
    assert.equal(raw.sampleStepMForBounds(inside), 8);
    assert.equal(snapshot.sampleStepMForBounds(crossing), 4);
    const view = createPublishedTerrainReference(snapshot, limits);
    publish(view, [tile(snapshot), tile(snapshot, 1, 0)]);
    const held = view.captureReadSnapshot('collider-lattice');
    assert.equal(held.sampleStepMForBounds(inside), 8);
    assert.equal(held.sampleStepMForBounds(crossing), 4);
    publish(view, [tile(captureTerrainReadSnapshot(fine(4)))]);
    assert.equal(view.sampleStepMForBounds(inside), 4);
    assert.equal(held.sampleStepMForBounds(inside), 8);
    held.release(); view.close();
});
function sampleTriangles(row, x, z) {
    const localX = x - row.tileX * tileM, localZ = z - row.tileZ * tileM;
    const positions = row.positions;
    for (let i = 0; i < row.indices.length; i += 3) {
        const a = row.indices[i] * 3, b = row.indices[i + 1] * 3, c = row.indices[i + 2] * 3;
        const ax = positions[a], az = positions[a + 2], bx = positions[b], bz = positions[b + 2], cx = positions[c], cz = positions[c + 2];
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const u = ((bz - cz) * (localX - cx) + (cx - bx) * (localZ - cz)) / denominator;
        const v = ((cz - az) * (localX - cx) + (ax - cx) * (localZ - cz)) / denominator;
        if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8) {
            return u * positions[a + 1] + v * positions[b + 1] + (1 - u - v) * positions[c + 1];
        }
    }
    return null;
}

test('a read snapshot preserves source, pending evidence and session datum across live replacements', () => {
    const live = reference((x, z) => 100 + x * z * 0.0003);
    live.anchorHeightM = 98.5;
    live.setPendingDetailWindow({ minX: 5, maxX: 15, minZ: 5, maxZ: 15 });
    const snapshot = captureTerrainReadSnapshot(live), before = snapshot.sceneYAtLocal(9, 11);
    live.clearPendingDetailWindow({ notify: false });
    live.replaceGrid(makeGrid(() => 150));
    assert.equal(snapshot.evidenceSceneYAtLocal(9, 11), null);
    assert.equal(snapshot.sceneYAtLocal(9, 11), before);
    assert.equal(snapshot.anchorHeightM, 98.5);
    assert.equal(snapshot.replaceGrid, undefined);
    assert.equal(snapshot.roadFormation, undefined);
    assert.throws(() => { snapshot.revision = 50; }, TypeError);
    assert.throws(() => { snapshot.pendingDetailWindow.minX = -100; }, TypeError);
    const worker = deserializeTerrainReference(drain(serializeTerrainSnapshotSteps(snapshot.source)));
    assert.equal(worker.sceneYAtLocal(9, 11), before);
    assert.equal(worker.anchorHeightM, 98.5);
    assert.notEqual(live.sceneYAtLocal(9, 11), before);
});

test('all yields retain old queries; commit changes only prepared tiles and rollback restores them', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const view = createPublishedTerrainReference(first, limits);
    const oldRows = [tile(first, 0), tile(first, 2)];
    publish(view, oldRows);
    const oldDistant = view.getTile(2, 0), events = [];
    view.onChange((revision, event) => events.push({ revision, event, height: view.sceneYAtLocal(11, 7) }));
    live.replaceGrid(makeGrid((x, z) => 101 + x * z * 0.0005));
    const second = captureTerrainReadSnapshot(live), next = tile(second);
    const phases = new Set();
    const tx = drain(view.prepareSteps([next]), step => {
        if (!step.done) phases.add(step.value.phase);
        assert.equal(view.sceneYAtLocal(11, 7), 0); assert.equal(view.revision, 1);
    });
    assert.ok(phases.has('retain-tile') && phases.has('mesh-query-tail') && phases.has('source-peak'));
    assert.equal(view.evidenceSceneYAtLocal(50, 10), null, 'source coverage is not a rendered tile');
    assert.equal(view.heightAt(...Object.values(first.lonLatAtLocal(50, 10))), null);
    assert.equal(view.sceneYAtLocal(90, 7), 0);
    assert.equal(tx.commit(), true);
    for (const [x, z] of [[1.2, 5.7], [15, 15], [24.5, 31.2], [39.9, 0.1]]) {
        assert.ok(Math.abs(view.sceneYAtLocal(x, z) - sampleTriangles(next, x, z)) <= 0.001);
    }
    assert.equal(view.getTile(2, 0), oldDistant, 'an unprepared tile cannot see a global new grid');
    assert.equal(events.length, 0, 'observers must wait for other group participants');
    assert.equal(tx.rollback(), true); assert.equal(view.sceneYAtLocal(11, 7), 0);
    assert.equal(tx.commit(), true); assert.equal(tx.notify(), true);
    assert.equal(events.length, 1); assert.ok(Math.abs(events[0].height - sampleTriangles(next, 11, 7)) < 1e-10);
    assert.deepEqual(events[0].event.changedTileKeys, ['0_0']);
    assert.equal(tx.rollback(), false, 'cannot roll back an announced generation');
});

test('coarse/fine seams test intermediate fine knots, then accept the complete changed region', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const view = createPublishedTerrainReference(first, limits);
    publish(view, [tile(first, 0), tile(first, 1)]);
    // Endpoints z=0,20,40 stay zero, but the new fine surface has a bump at z=10.
    live.replaceGrid(makeGrid((_x, z) => 100 + Math.max(0, 1 - Math.abs(z - 10) / 8)), {
        detail: { tileM, stepM: 4, rects: [{ minX: -40, maxX: 120, minZ: -40, maxZ: 80 }] },
    });
    const second = captureTerrainReadSnapshot(live);
    assert.ok(Math.abs(first.sceneYAtLocal(40, 0) - second.sceneYAtLocal(40, 0)) < 0.001);
    assert.ok(Math.abs(first.sceneYAtLocal(40, 20) - second.sceneYAtLocal(40, 20)) < 0.001);
    assert.throws(() => drain(view.prepareSteps([tile(second, 0)])), error => {
        assert.equal(error.code, 'terrain-publication-seam');
        assert.equal(error.details.neighbourKey, '1_0');
        assert.ok(error.details.z > 0 && error.details.z < 20); return true;
    });
    assert.equal(view.sceneYAtLocal(30, 10), 0);
    publish(view, [tile(second, 0), tile(second, 1)]);
    for (let z = 0; z <= 40; z += 0.5) {
        assert.ok(Math.abs(sampleTriangles(tile(second, 0), 40, z) - view.sceneYAtLocal(40, z)) <= 0.001);
    }
});

test('wrong diagonal, non-finite vertices and stale mesh heights cannot claim a matching sampler', () => {
    const first = captureTerrainReadSnapshot(reference((x, z) => 100 + x * z * 0.001));
    const view = createPublishedTerrainReference(first, limits);
    const wrongDiagonal = tile(first);
    wrongDiagonal.indices.set([0, 3, 4, 0, 4, 1], 0);
    assert.throws(() => drain(view.prepareSteps([wrongDiagonal])), { code: 'terrain-publication-diagonal' });
    const stale = tile(first); stale.positions[4] += 0.1;
    assert.throws(() => drain(view.prepareSteps([stale])), { code: 'terrain-publication-mesh-query' });
    const invalid = tile(first); invalid.positions[1] = NaN;
    assert.throws(() => drain(view.prepareSteps([invalid])), { code: 'terrain-publication-mesh-query' });
    assert.equal(view.usage().tiles, 0);
    assert.equal(view.evidenceSceneYAtLocal(10, 10), null);
    publish(view, [tile(first)]);
});

test('cancellation, candidate exclusion, source bytes and snapshot limits retain the old world', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const view = createPublishedTerrainReference(first, { ...limits, maxSourceBytes: first.source.grid.values.byteLength });
    publish(view, [tile(first)]);
    const partial = view.prepareSteps([tile(first)]); partial.next();
    assert.throws(() => drain(view.prepareSteps([tile(first)])), { code: 'terrain-publication-pending' });
    partial.return();
    const duplicate = captureTerrainReadSnapshot(live);
    publish(view, [tile(duplicate, 2)]);
    assert.equal(view.usage().sourceBytes, first.source.grid.values.byteLength, 'shared source buffers count once');
    live.replaceGrid(makeGrid(() => 101));
    const next = captureTerrainReadSnapshot(live);
    assert.throws(() => drain(view.prepareSteps([tile(next)])), { code: 'terrain-publication-capacity' });
    assert.equal(view.sceneYAtLocal(10, 10), 0);
    const snapshotLimited = createPublishedTerrainReference(first, { ...limits, maxSnapshots: 1 });
    publish(snapshotLimited, [tile(first)]);
    assert.throws(() => drain(snapshotLimited.prepareSteps([tile(duplicate, 2)])), { code: 'terrain-publication-capacity' });
    const tx = drain(view.prepareSteps([], { removeKeys: ['2_0'] }));
    assert.equal(tx.discard(), true); assert.equal(view.usage().tiles, 2);
    publish(view, [], { removeKeys: ['2_0'] });
    assert.equal(view.usage().snapshots, 1); assert.equal(view.evidenceSceneYAtLocal(90, 10), null);
});

test('NoData remains null evidence and never becomes a measured fallback datum', () => {
    const first = captureTerrainReadSnapshot(reference((x, z) => x > 5 && x < 35 && z > 5 && z < 35 ? null : 100));
    const view = createPublishedTerrainReference(first, limits);
    publish(view, [tile(first)]);
    assert.equal(view.evidenceSceneYAtLocal(20, 20), null);
    assert.equal(view.sceneYAtLocal(20, 20), -100);
    assert.equal(view.evidenceNormalAtLocal(20, 20, 2), null);
    assert.equal(view.hasLoadedCoreCoverageAtLocal(20, 20), true);
    assert.equal(view.evidenceSceneYAtLocal(null, 0), null);
    assert.equal(view.evidenceSceneYAtLocal(0, null), null);
    assert.equal(view.evidenceSceneYAtLocal(0, 0), 0);
    assert.equal(view.evidenceSceneYAtLocal(40, 40), 0, 'closed outer edge retains actual tile coverage');
});

test('the existing registry switches real terrain meshes, tiled queries and Rapier together or rolls all back', t => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const view = createPublishedTerrainReference(first, limits);
    const scene = new THREE.Scene(), registry = createSurfacePublicationRegistry();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }), active = new Map(), metadata = new Map();
    t.after(() => { registry.close({ retireActive: true }); world.free(); });
    let generation = 0;
    const rayY = () => {
        world.step();
        const hit = world.castRay(new RAPIER.Ray({ x: 10, y: 10, z: 10 }, { x: 0, y: -1, z: 0 }), 20, true);
        return hit ? 10 - hit.timeOfImpact : null;
    };
    const prepare = snapshot => {
        const row = tile(snapshot), terrainTx = drain(view.prepareSteps([row]));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(row.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(row.indices, 1));
        const root = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        root.userData.surfaceClaim = { surfaceClass: 'terrain', verticalBand: 'ground', verticalRelation: 'same-level', coverageState: 'published' };
        const physics = prepareFixedSurfacePublication({ RAPIER, world, active, metadata,
            replacements: [{ key: 'terrain', spec: { id: 'terrain' }, meshes: [{ vertices: row.positions, indices: row.indices,
                friction: 1, collisionGroups: 0xffffffff }] }], activeColliderCount: active.size,
            maxColliders: 1, maxStagedColliders: 1 });
        const ticket = registry.begin({ key: 'terrain:0_0', generation: ++generation, parent: scene,
            retire: (_context, mesh) => { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); } });
        const batch = injectFailure => registry.prepareBatch([{ ticket, root, isCurrent: terrainTx.isCurrent }], {
            commit() {
                assert.equal(terrainTx.commit(), true); assert.equal(physics.promote(), true);
                if (injectFailure) throw new Error('injected later participant failure');
            }, rollback() { physics.rollback(); terrainTx.rollback(); },
        });
        return { row, root, terrainTx, physics, batch };
    };
    const old = prepare(first); old.batch(false).publish(); old.physics.retire(); old.terrainTx.notify();
    assert.equal(rayY(), 0);
    const observations = [];
    registry.subscribe(() => observations.push([view.sceneYAtLocal(10, 10), rayY(), scene.children.length]));
    view.onChange(() => observations.push([view.sceneYAtLocal(10, 10), rayY(), scene.children.length]));
    live.replaceGrid(makeGrid(() => 101));
    const second = captureTerrainReadSnapshot(live);
    const failed = prepare(second);
    assert.equal(rayY(), 0, 'staged Rapier body remains disabled');
    assert.equal(view.sceneYAtLocal(10, 10), 0);
    assert.throws(() => failed.batch(true).publish(), /injected/);
    failed.physics.dispose(); failed.terrainTx.discard();
    assert.equal(scene.children.length, 1); assert.equal(scene.children[0], old.root);
    assert.equal(rayY(), 0); assert.equal(view.sceneYAtLocal(10, 10), 0);
    assert.equal(observations.length, 0);
    const next = prepare(second); next.batch(false).publish(); next.physics.retire(); next.terrainTx.notify();
    assert.deepEqual(observations, [[1, 1, 1], [1, 1, 1]]);
    assert.equal(scene.children[0], next.root);
    assert.equal(world.colliders.len(), 1); assert.equal(world.bodies.len(), 1);
});

test('large lattice verification bounds real sampler calls per visit and closed sessions reject late work', () => {
    const first = captureTerrainReadSnapshot(reference((x, z) => 100 + x * z * 0.0005, {
        detail: { tileM, stepM: 2, rects: [{ minX: -40, maxX: 120, minZ: -40, maxZ: 80 }] },
    }));
    const row = tile(first);
    let calls = 0, last = 0, maxCalls = 0;
    // Count calls through the exact production sampler. The mesh was compiled
    // before counting, so preparation cannot hide them in fixture construction.
    row.snapshot = Object.freeze({ ...first, sceneYAtLocal(x, z) { calls++; return first.sceneYAtLocal(x, z); } });
    const view = createPublishedTerrainReference(first, limits);
    const tx = drain(view.prepareSteps([row]), () => {
        maxCalls = Math.max(maxCalls, calls - last); last = calls;
        assert.ok(maxCalls <= 64, `one preparation visit sampled ${maxCalls} points`);
    });
    assert.equal(calls, 441);
    assert.equal(maxCalls, 64);
    assert.equal(view.close(), true); assert.equal(view.close(), false);
    assert.equal(tx.commit(), false);
    assert.equal(tx.discard(), true);
    assert.equal(view.usage().sourceBytes, 0);
    assert.equal(view.evidenceSceneYAtLocal(10, 10), null);
    assert.throws(() => drain(view.prepareSteps([row])), { code: 'terrain-publication-closed' });
});

test('owned terrain readers preserve old and prepared triangles and count in the staging peak', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const bytes = first.source.grid.values.byteLength;
    const view = createPublishedTerrainReference(first, { ...limits, maxSourceBytes: bytes * 2 });
    publish(view, [tile(first)]);
    assert.throws(() => view.captureReadSnapshot(), /requires an owner/);
    const old = view.captureReadSnapshot('road-generation-1');
    assert.equal(Object.isFrozen(old), true); assert.equal(old.prepareSteps, undefined);
    live.replaceGrid(makeGrid(() => 101));
    const second = captureTerrainReadSnapshot(live);
    publish(view, [tile(second)]);
    assert.equal(old.sceneYAtLocal(10, 10), 0); assert.equal(view.sceneYAtLocal(10, 10), 1);
    assert.equal(view.usage().residentSourceBytes, bytes * 2);
    assert.equal(view.usage().residentSnapshots, 2); assert.equal(view.usage().readSnapshots, 1);
    live.replaceGrid(makeGrid(() => 102));
    const third = captureTerrainReadSnapshot(live), thirdTile = tile(third);
    assert.throws(() => drain(view.prepareSteps([thirdTile])), { code: 'terrain-publication-capacity' });
    assert.equal(view.sceneYAtLocal(10, 10), 1, 'slow readers cannot force a partial publication');
    assert.equal(old.release(), true); assert.equal(old.release(), false);
    assert.throws(() => old.sceneYAtLocal(10, 10), { code: 'terrain-read-released' });
    assert.equal(view.usage().residentSourceBytes, bytes);
    const candidate = drain(view.prepareSteps([thirdTile]));
    const next = candidate.captureReadSnapshot('road-generation-3');
    assert.ok(Math.abs(next.sceneYAtLocal(10, 10) - sampleTriangles(thirdTile, 10, 10)) <= .001);
    assert.equal(view.sceneYAtLocal(10, 10), 1);
    assert.equal(view.usage().residentSourceBytes, bytes * 2);
    candidate.discard();
    assert.ok(Math.abs(next.sceneYAtLocal(10, 10) - 2) < 1e-10, 'consumer owns its completed read until it releases it');
    assert.equal(view.usage().residentSourceBytes, bytes * 2, 'discard cannot hide retained consumer buffers');
    assert.throws(() => candidate.captureReadSnapshot('late'), { code: 'terrain-publication-settled' });
    live.replaceGrid(makeGrid(() => 103));
    const fourth = captureTerrainReadSnapshot(live);
    assert.throws(() => drain(view.prepareSteps([tile(fourth)])), { code: 'terrain-publication-capacity' });
    next.release();
    publish(view, [tile(fourth)]);
    assert.ok(Math.abs(view.sceneYAtLocal(10, 10) - 3) < 1e-10);
    assert.equal(view.usage().residentSourceBytes, bytes);
});

test('terrain read-view and source-snapshot limits include retained consumers, and closing revokes them', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const view = createPublishedTerrainReference(first, { ...limits, maxReadSnapshots: 1, maxSnapshots: 2 });
    publish(view, [tile(first)]);
    const old = view.captureReadSnapshot('road-builder');
    assert.throws(() => view.captureReadSnapshot('curb-builder'), { code: 'terrain-publication-capacity' });
    live.replaceGrid(makeGrid(() => 101)); publish(view, [tile(captureTerrainReadSnapshot(live))]);
    live.replaceGrid(makeGrid(() => 102));
    assert.throws(() => drain(view.prepareSteps([tile(captureTerrainReadSnapshot(live))])), { code: 'terrain-publication-capacity' });
    assert.equal(old.sceneYAtLocal(10, 10), 0);
    view.close();
    assert.throws(() => old.evidenceSceneYAtLocal(10, 10), { code: 'terrain-read-released' });
    assert.equal(old.release(), false);
    assert.equal(view.usage().readSnapshots, 0); assert.equal(view.usage().residentSourceBytes, 0);
    assert.throws(() => view.captureReadSnapshot('late'), { code: 'terrain-publication-closed' });
});

test('derived terrain owners preserve captured callbacks until the last release and remain budgeted', () => {
    const live = reference(), first = captureTerrainReadSnapshot(live);
    const bytes = first.source.grid.values.byteLength;
    const view = createPublishedTerrainReference(first, { ...limits, maxReadSnapshots: 2, maxSourceBytes: bytes * 2 });
    publish(view, [tile(first)]);
    const builder = captureGroundReadSnapshot(view, 'formation-builder');
    const sampleThroughPublishedRoad = (x, z) => builder.sceneYAtLocal(x, z);
    const roadOwner = builder.retain('published-road-callbacks');
    assert.equal(view.usage().readSnapshots, 2);
    assert.equal(view.usage().residentSourceBytes, bytes, 'derived callbacks share the immutable source buffers');
    assert.throws(() => builder.retain('unadmitted-curb'), { code: 'terrain-publication-capacity' });
    assert.equal(builder.release(), true);
    assert.equal(builder.release(), false);
    assert.equal(view.usage().readSnapshots, 1);
    live.replaceGrid(makeGrid(() => 101));
    publish(view, [tile(captureTerrainReadSnapshot(live))]);
    assert.equal(view.sceneYAtLocal(10, 10), 1);
    assert.equal(sampleThroughPublishedRoad(10, 10), 0, 'the published road still owns the captured callback');
    assert.equal(view.usage().residentSourceBytes, bytes * 2);
    live.replaceGrid(makeGrid(() => 102));
    const third = tile(captureTerrainReadSnapshot(live));
    assert.throws(() => drain(view.prepareSteps([third])), { code: 'terrain-publication-capacity' });
    roadOwner.release();
    assert.equal(view.usage().readSnapshots, 0);
    assert.equal(view.usage().residentSourceBytes, bytes);
    assert.throws(() => sampleThroughPublishedRoad(10, 10), { code: 'terrain-read-released' });
    assert.throws(() => roadOwner.retain('too-late'), { code: 'terrain-read-released' });
    publish(view, [third]);
    assert.ok(Math.abs(view.sceneYAtLocal(10, 10) - 2) < 1e-10);
    const next = view.captureReadSnapshot('next-builder');
    const dependent = next.retain('next-road');
    view.close();
    assert.equal(next.release(), false);
    assert.equal(dependent.release(), false);
    assert.throws(() => next.sceneYAtLocal(10, 10), { code: 'terrain-read-released' });
    assert.throws(() => dependent.sceneYAtLocal(10, 10), { code: 'terrain-read-released' });
    assert.equal(view.usage().residentSourceBytes, 0);
});
