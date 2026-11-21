import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureTerrainReadSnapshot } from '../core/terrain-snapshot.js';
import { serializeTerrainSnapshotSteps, terrainSnapshotTransferables, deserializeTerrainReference } from '../core/terrain-snapshot.js';
import { compileTerrainRenderPacket } from '../core/compilers/terrain-render-packet.js';
import { createRenderPacketUploadTask } from '../core/render-packet-three.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';

const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
const functionSource = (name, end) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(end, source.indexOf(`function ${name}(`)));
const tileM = 40;
function grid(height) {
    const metadata = { grid: { width: 20, height: 20,
        bounds: { west: 15.99, east: 16.01, south: 45.79, north: 45.81 } },
    encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } };
    return new TerrainGrid(metadata, new Uint16Array(400).fill(height * 100).buffer);
}

test('actual compiler installation exposes only the current immutable input after worker acknowledgement', async () => {
    const raw = new TerrainReference(grid(100), 16, 45.8, { surfaceStepM: 2 });
    const installs = [];
    let pumped = 0;
    const runtime = vm.createContext({ reference: raw, terrainCompilerReadSnapshot: null, terrainGroundGenerationLease: null,
        terrainCompilerSnapshotFailure: null, terrainGridPrepQueue: {},
        captureTerrainReadSnapshot, serializeTerrainSnapshotSteps, terrainSnapshotTransferables,
        async runTerrainGridPrepIterator(iterator) {
            for (;;) { const step = iterator.next(); if (step.done) return step.value; }
        },
        pumpTerrainTileBuilds: () => pumped++, rejectTerrainBuildWaiters() {},
        renderCompiler: { setState(_key, prepare, options) {
            return new Promise(resolve => installs.push({ prepare, options, resolve }));
        } } });
    // One fixed list: the installer compares the list's identity (isochrone bdaf93dc, before the extraction).
    runtime.terrainRenderCompilers = [runtime.renderCompiler];
    const start = source.indexOf('async function installTerrainCompilerSnapshot(');
    vm.runInContext(source.slice(start, source.indexOf('\nfunction discardActiveTerrainTileBuild(', start)), runtime);
    const first = runtime.installTerrainCompilerSnapshot();
    raw.replaceGrid(grid(101));
    const second = runtime.installTerrainCompilerSnapshot();
    const oldPacket = await installs[0].prepare({});
    const newPacket = await installs[1].prepare({});
    assert.equal(deserializeTerrainReference(oldPacket.payload.snapshot).sceneYAtLocal(20, 20), 0);
    assert.equal(deserializeTerrainReference(newPacket.payload.snapshot).sceneYAtLocal(20, 20), 1);
    assert.equal(runtime.terrainCompilerReadSnapshot, null);
    installs[0].resolve(true);
    await first;
    assert.equal(runtime.terrainCompilerReadSnapshot, null, 'late acknowledgement cannot install an obsolete local read');
    assert.equal(pumped, 0);
    installs[1].resolve(true);
    await second;
    assert.equal(runtime.terrainCompilerReadSnapshot.revision, raw.revision);
    assert.equal(runtime.terrainCompilerReadSnapshot.sceneYAtLocal(20, 20), 1);
    assert.equal(pumped, 1);
});

function fixture() {
    const raw = new TerrainReference(grid(100), 16, 45.8, { surfaceStepM: 2 });
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const parent = new THREE.Group(), tiles = new Map();
    const disposed = [];
    const runtime = vm.createContext({ tiles, terrainGroup: parent, generation: 1,
        activeTileBuild: null, terrainTileSurfaceSignature: () => 'next',
        disposeTerrainTileMesh(root) { root.removeFromParent(); root.geometry?.dispose(); } });
    vm.runInContext(functionSource('prepareTerrainTilePublication', '\nfunction terrainTileSurfaceSignature(')
        + functionSource('discardActiveTerrainTileBuild', '\nfunction beginTerrainTilePublication('), runtime);
    const ticket = generation => registry.begin({ key: 'terrain:0:0', generation, parent,
        retire: (_context, root) => runtime.disposeTerrainTileMesh(root) });
    function root(read, generation) {
        const packet = compileTerrainRenderPacket({ sourceRevision: `terrain:${read.revision}`,
            generation, tile: { matrix: 'station3d-local-metre-v1', z: 0, x: 0, y: 0,
                originLon: 16, originLat: 45.8, sizeM: tileM },
            inputs: { snapshotRevision: read.revision, tileX: 0, tileZ: 0, tileM,
                segments: 20, uvPerM: .1 } }, read);
        const primitive = packet.primitives[0];
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(primitive.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(primitive.indices, 1));
        const mesh = new THREE.Mesh(geometry);
        geometry.addEventListener('dispose', () => disposed.push(mesh));
        // GPU upload is covered by the separate native checks. This headless
        // test exercises the handoff after that contract has been satisfied.
        mesh.userData.terrainGpuPrepared = true;
        markSurfaceClaim(mesh, { surfaceClass: SURFACE_CLASS.TERRAIN, ownerId: 'terrain:0:0',
            replacementKey: 'terrain:0:0', generation, verticalBand: 'ground', supportReady: true });
        return mesh;
    }
    const old = root(captureTerrainReadSnapshot(raw), 1);
    ticket(1).publish(old); tiles.set('0_0', old);
    raw.replaceGrid(grid(101));
    const ground = captureTerrainReadSnapshot(raw);
    const next = root(ground, 2);
    const build = { job: { key: '0_0' }, tileX: 0, tileZ: 0, surfaceSignature: 'next',
        publicationTicket: ticket(2), ground,
        uploadController: new AbortController(), compileHandle: { cancel() {} } };
    runtime.activeTileBuild = build;
    const entry = runtime.prepareTerrainTilePublication(build, next);
    return { raw, registry, boundary, parent, tiles, disposed, runtime, old, next, build, entry };
}

test('production terrain entry waits for the frame and rolls back with a later failed member', async () => {
    const f = fixture();
    const observed = [];
    f.registry.subscribe(() => observed.push(f.tiles.get('0_0')));
    const failure = f.registry.begin({ key: 'physics', generation: 1 });
    const batch = f.registry.prepareBatch([f.entry, { ticket: failure, clear: true,
        commit() { throw new Error('physics refused'); } }]);
    const queued = f.boundary.enqueue(batch);
    assert.equal(f.next.parent, null);
    assert.equal(f.tiles.get('0_0'), f.old);
    const rejected = assert.rejects(queued.promise, /physics refused/);
    f.boundary.publishReady();
    await rejected;
    assert.equal(f.tiles.get('0_0'), f.old);
    assert.equal(f.registry.getActive('terrain:0:0').root, f.old);
    assert.deepEqual(f.parent.children, [f.old]);
    assert.deepEqual(f.disposed, [f.next]);
    assert.deepEqual(observed, []);
    f.registry.close({ retireActive: true });
});

test('production terrain entry retains the exact captured packet input while newer source state arrives', async () => {
    const f = fixture();
    f.raw.replaceGrid(grid(102));
    assert.equal(f.build.ground.sceneYAtLocal(20, 20), 1);
    assert.equal(f.raw.sceneYAtLocal(20, 20), 2);
    const queued = f.boundary.enqueue(f.registry.prepareBatch([f.entry]));
    const controllerRead = () => f.tiles.get('0_0').geometry.attributes.position.getY(0);
    assert.equal(controllerRead(), 0);
    f.boundary.publishReady();
    assert.equal(controllerRead(), 1);
    assert.equal((await queued.promise).status, 'published');
    assert.equal(f.next.userData.terrainSourceRevision, f.build.ground.revision);
    assert.deepEqual(f.disposed, [f.old]);
    f.registry.close({ retireActive: true });
    assert.deepEqual(f.disposed, [f.old, f.next]);
});

test('fully cut terrain publishes an explicit removal and a current empty receiver, with rollback', () => {
    const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
    for (const rollback of [false, true]) {
        const f = fixture();
        f.build.publicationTicket.discard();
        const ring = [[-1, -1], [41, -1], [41, 41], [-1, 41]].map(([x, z]) => ({ x, z }));
        const packet = compileTerrainRenderPacket({ sourceRevision: 'empty', generation: 3,
            tile: { matrix: 'test', z: 0, x: 0, y: 0, originLon: 16, originLat: 45.8, sizeM: tileM },
            inputs: { tileX: 0, tileZ: 0, tileM, segments: 20, uvPerM: 1, snapshotRevision: f.build.ground.revision,
                cutout: { ...GROUND_GENERATION_LIMITS.cutout,
                    layers: [{ operation: 'subtract', regions: [{ ring }] }] } } }, f.build.ground);
        const material = new THREE.MeshBasicMaterial();
        Object.assign(f.runtime, { createRenderPacketUploadTask, terrainMaterial: material,
            terrainPublicationKey: () => 'terrain:0:0', TILE_M: tileM,
            reference: f.raw, finiteOrNull: value => Number.isFinite(value) ? value : null,
            GROUND_STENCIL_READER_RENDER_ORDER: 2,
            prewarmDetachedObject() { throw new Error('An empty tile must not request GPU work'); } });
        vm.runInContext(source.slice(source.indexOf('function* createTerrainTileRootSteps('),
            source.indexOf('\nfunction removeTile(')) + source.slice(source.indexOf('export function isTerrainTilePublishedAtLocal('),
            source.indexOf('\nfunction terrainPacketTile(')).replace('export function', 'function'), f.runtime);
        const empty = drain(f.runtime.createTerrainTileRootSteps(packet, 0, 0, 'next', 3));
        assert.equal(empty.userData.terrainEmpty, true);
        assert.equal(empty.children.length, 0);
        const provider = createPublishedTerrainReference(f.build.ground, { ...GROUND_GENERATION_LIMITS.terrainPublication, tileM });
        const p = packet.primitives[0];
        const query = drain(provider.prepareSteps([{ snapshot: f.build.ground, tileX: 0, tileZ: 0, segments: 20,
            positions: p.terrainLattice.positions, indices: p.terrainLattice.indices,
            receiver: { positions: p.positions, indices: p.indices, sourceTriangleOffsets: p.terrainLattice.sourceTriangleOffsets } }]));
        f.build.publicationTicket = f.registry.begin({ key: 'terrain:0:0', generation: 3, parent: f.parent });
        const entry = f.runtime.prepareTerrainTilePublication(f.build, empty);
        assert.equal(entry.clear, true);
        const batch = f.registry.prepareBatch([entry, {
            ticket: f.registry.begin({ key: 'query', generation: 3 }), clear: true,
            commit: () => query.commit(), rollback: () => query.rollback(), discard: () => query.discard(),
        }], rollback ? { commit() { throw new Error('later member failed'); } } : {});
        if (rollback) {
            assert.throws(() => batch.publish(), /later member failed/);
            assert.equal(f.tiles.get('0_0'), f.old);
            assert.equal(f.registry.getActive('terrain:0:0').root, f.old);
        } else {
            assert.equal(batch.publish().status, 'published');
            query.notify();
            assert.equal(f.registry.getActive('terrain:0:0'), null);
            assert.equal(f.parent.children.length, 0);
            assert.equal(f.runtime.isTerrainTilePublishedAtLocal(20, 20), true);
            assert.equal(provider.receiverSceneYAtLocal(20, 20), null, 'empty receipt cannot invent a support floor');
            f.runtime.terrainTileSurfaceSignature = () => 'newer';
            assert.equal(f.runtime.isTerrainTilePublishedAtLocal(20, 20), false);
        }
        f.registry.close({ retireActive: true }); provider.close(); material.dispose(); f.next.geometry.dispose();
    }
});

test('actual cab frame prefix promotes prepared terrain after restoration and startup, before controller queries', async () => {
    const f = fixture(), events = [];
    const queued = f.boundary.enqueue(f.registry.prepareBatch([f.entry]));
    const cabState = { layerStartup: { tick: () => events.push('startup') },
        groundPublications: { snapshot: f.boundary.snapshot,
            publishReady() { events.push('publish'); return f.boundary.publishReady(); } },
        controllerRouter: { step() {
            events.push('controller');
            assert.equal(f.tiles.get('0_0'), f.next);
            return { height: f.next.geometry.attributes.position.getY(0) };
        } } };
    const runtime = vm.createContext({ state: { cabState }, performance,
        restoreAbsoluteRenderCoordinates: () => events.push('restore'),
        tickWorldReady() {}, isWorldBuilding: () => false, isPhotoWorld: () => false,
        setPhotoLoading() {}, abandonDestroyedAmbientTram() {}, recordLayerFrameMs() {} });
    const cab = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
    const start = cab.indexOf('function cabStep() {');
    const end = cab.indexOf('    const activeControllerId =', start);
    assert.ok(start >= 0 && end > start);
    // Execute the production frame through its first controller step; later
    // camera/HUD work is unrelated to this boundary and needs no DOM fixture.
    vm.runInContext(cab.slice(start, end) + '\nreturn pose; }', runtime);
    assert.equal(runtime.cabStep().height, 1);
    assert.deepEqual(events, ['restore', 'startup', 'publish', 'controller']);
    assert.equal((await queued.promise).status, 'published');
    f.registry.close({ retireActive: true });
});

test('production terrain cancellation and stale session retain active tile and release detached upload once', async () => {
    for (const cancel of [true, false]) {
        const f = fixture();
        f.build.framePublication = f.boundary.enqueue(f.registry.prepareBatch([f.entry]));
        if (cancel) f.runtime.discardActiveTerrainTileBuild('terrain-window-shifted');
        else { f.runtime.generation++; f.boundary.publishReady(); }
        const result = await f.build.framePublication.promise;
        assert.equal(result.status, cancel ? 'terrain-window-shifted' : 'dependency-revised');
        assert.equal(f.tiles.get('0_0'), f.old);
        assert.deepEqual(f.parent.children, [f.old]);
        assert.deepEqual(f.disposed, [f.next]);
        assert.equal(f.boundary.publishReady(), false);
        f.registry.close({ retireActive: true });
    }
});
