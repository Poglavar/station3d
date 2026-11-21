// Exercise the real terrain publication/queue orchestration without a browser,
// including cancellation in the completion-to-Promise-continuation gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createRenderPacketUploadTask } from '../core/render-packet-three.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureTerrainReadSnapshot } from '../core/terrain-snapshot.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { compileTerrainRenderPacket, TERRAIN_PACKET_COMPILER_ID, TERRAIN_PACKET_COMPILER_VERSION } from '../core/compilers/terrain-render-packet.js';

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };

function fixture({ deferShaders = false } = {}) {
    const grid = y => new TerrainGrid({ grid: { width: 5, height: 5,
        bounds: { west: 15.99, east: 16.01, south: 45.79, north: 45.81 } },
        encoding: { scaleM: .01, offsetM: 100, noDataValue: 65535 } }, new Uint16Array(25).fill(y * 100).buffer);
    const reference = new TerrainReference(grid(0), 16, 45.8, { surfaceStepM: 400 / 110 });
    const oldRead = captureTerrainReadSnapshot(reference);
    const packetFor = read => compileTerrainRenderPacket({ sourceRevision: `source:${read.revision}`, generation: 1,
        tile: { matrix: 'test', z: 0, x: 0, y: 0, originLon: 16, originLat: 45.8, sizeM: 400 },
        inputs: { tileX: 0, tileZ: 0, tileM: 400, segments: 110, uvPerM: 1, snapshotRevision: read.revision } }, read);
    const oldPacket = packetFor(oldRead), oldPrimitive = oldPacket.primitives[0];
    const publishedTerrain = createPublishedTerrainReference(oldRead, { tileM: 400, maxTiles: 4, maxChangedTiles: 4,
        maxSnapshots: 8, maxReadSnapshots: 16, maxSourceBytes: 100000, maxReceiverBytes: 4 * 1024 ** 2, maxSegments: 128 });
    const initial = drain(publishedTerrain.prepareSteps([{ snapshot: oldRead, tileX: 0, tileZ: 0, segments: 110,
        positions: oldPrimitive.terrainLattice.positions, indices: oldPrimitive.terrainLattice.indices }]));
    initial.commit(); initial.notify(); reference.replaceGrid(grid(1));
    const oldPublishedY = publishedTerrain.sceneYAtLocal(10, 10);
    const terrainRead = captureTerrainReadSnapshot(reference), packet = packetFor(terrainRead);
    const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
    const repeat = Symbol('repeat'), jobs = [], uploads = [], published = [], tickets = [], disposed = [];
    let resolvePacket, rejectPacket;
    const promise = new Promise((resolve, reject) => { resolvePacket = resolve; rejectPacket = reject; });
    const compileRequests = [];
    const queue = {
        enqueue(_items, onItem, options) {
            let resolve;
            const job = { onItem, options, complete: false, promise: new Promise(r => { resolve = r; }), resolve };
            jobs.push(job); return job;
        },
        cancel(job) {
            if (job.complete) return;
            job.complete = true; job.options.onCancel?.(); job.resolve({ cancelled: true });
        },
    };
    const previous = new THREE.Group();
    const terrainGroup = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    let materialDisposals = 0, target = null;
    material.addEventListener('dispose', () => { materialDisposals++; });
    const shaders = [], renders = [];
    const renderer = {
        compile(root) { shaders.push({ root }); },
        // The detached prewarm captures the programs compile() registered per material.
        properties: { get: () => ({ programs: new Map() }) },
        render(root) { renders.push(root); assert.equal(terrainGroup.children[0], previous); },
        initTexture() {}, clear() {},
        setRenderTarget(value) { target = value; }, getRenderTarget: () => target,
        shadowMap: { enabled: true, autoUpdate: true },
    };
    const surfacePublications = createSurfacePublicationRegistry({
        inspect: () => ({ meshCount: 1, claimCount: 1, surfaceClasses: [], verticalBands: [], ownerIds: [] }),
    });
    const groundPublications = createGroundPublicationBoundary();
    if (deferShaders) renderer.compileAsync = root => new Promise(resolve => shaders.push({ root, resolve }));
    const retire = (_context, root) => sandbox.disposeTerrainTileMesh(root);
    surfacePublications.begin({ key: 'terrain:0:0', generation: 0, parent: terrainGroup, retire }).publish(previous);
    surfacePublications.subscribe(event => { if (event.type === 'published') published.push(event.root); });
    const sandbox = {
        THREE, AbortController, FRAME_CHUNK_REPEAT_ITEM: repeat, terrainGridPrepQueue: queue,
        prewarmDetachedObject, renderer, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
        createRenderPacketUploadTask: (...args) => { const task = createRenderPacketUploadTask(...args); uploads.push(task); return task; },
        terrainPublicationKey: () => 'terrain:0:0', terrainMaterial: material, TILE_M: 400,
        GROUND_STENCIL_READER_RENDER_ORDER: 2, activeTileBuild: null, terrainGroundGenerationLease: null,
        pendingTileBuilds: [{ key: '0_0', ring: 0 }],
        terrainCompilerSnapshotFailure: null, rejectTerrainBuildWaiters() {},
        surfacePublications, groundPublications, generation: 1, groundManaged: false,
        publishedTerrain, terrainPublicationGeneration: 0, terrainCompilerReadSnapshot: terrainRead,
        renderCompiler: { compile: (request) => {
            compileRequests.push(request);
            return { promise: compileRequests.length === 1 ? promise : new Promise(() => {}), cancel() {} };
        } }, reference, terrainGroup,
        terrainTileSurfaceSignature: () => 'current', tiles: new Map([['0_0', previous]]),
        terrainTileBuildFailures: new Map(), beginTerrainTilePublication: () => {
            const generation = tickets.length + 1;
            const ticket = surfacePublications.begin({ key: 'terrain:0:0', generation, parent: terrainGroup, retire });
            tickets.push(ticket);
            return { publicationGeneration: generation, publicationTicket: ticket };
        },
        TERRAIN_PACKET_COMPILER_ID, TERRAIN_PACKET_COMPILER_VERSION,
        terrainPacketTile: () => packet.tile, tileMeshSegments: () => 110, terrainUvPerM: 1,
        notifyTerrainBuildWaiters() {},
        console: { error(...args) { throw Error(args.join(' ')); } },
        disposeTerrainTileMesh(root) {
            if (!root) return;
            disposed.push(root);
            root.traverse(child => child.geometry?.dispose()); root.parent?.remove(root);
        },
    };
    runInNewContext([
        section('function terrainGridPrepAbortError', 'function resetTerrainGridPrepQueue'),
        section('function resolveTerrainGridPrepPriority', 'function decodeTerrainGridPayloadQueued'),
        section('const terrainMaterialCompileFences', 'function* createTerrainTileRootSteps'),
        section('function* createTerrainTileRootSteps', 'function removeTile(key)'),
        section('function discardActiveTerrainTileBuild', 'function beginTerrainTilePublication'),
        section('function prepareTerrainTilePublication', 'function terrainTileSurfaceSignature'),
        section('function isExpectedCompilerCancellation', 'function pumpTerrainTileBuilds'),
        section('function pumpTerrainTileBuilds()', 'function prioritizePendingTerrainBuilds'),
    ].join('\n'), sandbox);
    return { sandbox, jobs, uploads, previous, published, disposed, compileRequests, rejectPacket,
        get discarded() { return tickets.map(ticket => ticket.state).filter(state => !['pending', 'staged', 'published'].includes(state)); },
        shaders, renders, material, get materialDisposals() { return materialDisposals; },
        async start() { sandbox.pumpTerrainTileBuilds(); resolvePacket(packet); await Promise.resolve(); },
        installCompilerSnapshot() {
            sandbox.terrainCompilerReadSnapshot = Object.freeze({ revision: sandbox.reference.revision });
            sandbox.pumpTerrainTileBuilds();
        },
        step() {
            const job = jobs.find(entry => !entry.complete);
            if (!job) return false;
            if (job.onItem() !== repeat) { job.complete = true; job.resolve({ cancelled: false }); }
            return true;
        },
        async flush() { for (let step = 0; step < 8; step++) await Promise.resolve(); },
        async finishQuery() {
            for (let n = 0; n < 10000; n++) {
                await this.flush();
                const job = jobs.find(entry => !entry.complete);
                if (!job || String(job.options.describeItem?.()).includes('publication-slot')) return;
                assert.equal(publishedTerrain.sceneYAtLocal(10, 10), oldPublishedY,
                    'query remains old during every preparation visit');
                this.step();
            }
            throw new Error('Terrain query preparation did not settle');
        },
        close() {
            sandbox.discardActiveTerrainTileBuild('test-cleanup');
            groundPublications.close();
            surfacePublications.close({ retireActive: true });
            publishedTerrain.close();
            for (const task of uploads) task.dispose();
            sandbox.retireTerrainMaterial(material);
        },
    };
}

test('a queued tile superseded by a terrain snapshot is reissued once against the current revision', async () => {
    const f = fixture();
    try {
        f.sandbox.pumpTerrainTileBuilds();
        assert.deepEqual({ ...f.compileRequests[0].requiredStates }, { terrain: 1 });
        f.sandbox.reference.revision = 2;
        f.rejectPacket(Object.assign(new Error('snapshot changed'), { code: 'state-superseded' }));
        await f.flush();
        assert.equal(f.compileRequests.length, 1, 'source intent cannot compile before its immutable worker input is installed');
        assert.equal(f.sandbox.pendingTileBuilds.length, 1);
        f.installCompilerSnapshot();
        assert.equal(f.compileRequests.length, 2);
        assert.deepEqual({ ...f.compileRequests[1].requiredStates }, { terrain: 2 });
        assert.equal(f.compileRequests[1].inputs.snapshotRevision, 2);
        assert.equal(f.published.length, 0);
        assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
        assert.equal(f.sandbox.terrainTileBuildFailures.size, 0);
        assert.equal(f.sandbox.pendingTileBuilds.length, 0);
    } finally { f.close(); }
});

for (const cancel of [false, true]) {
    test(`terrain retains one prepared upload behind another publication${cancel ? ' and cancels it without a leak' : ''}`, async () => {
        const f = fixture();
        try {
            const registry = f.sandbox.surfacePublications;
            const boundary = f.sandbox.groundPublications;
            const other = registry.begin({ key: 'road:nearby', generation: 1 });
            const road = boundary.enqueue(registry.prepareBatch([{ ticket: other, clear: true }]));
            const errors = [];
            f.sandbox.console.error = (...args) => errors.push(args);
            await f.start();
            while (f.step()) {}
            await f.finishQuery();
            assert.equal(f.sandbox.terrainTileBuildFailures.size, 0, 'a busy slot is backpressure, not a failed tile');
            assert.equal(errors.length, 0);
            assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
            assert.equal(f.compileRequests.length, 1, 'waiting cannot recompile or admit another tile');
            const waiting = f.jobs.find(job => !job.complete);
            assert.ok(waiting);
            assert.equal(waiting.options.maxItemsPerFrame, 1);
            for (let frame = 0; frame < 5; frame++) f.step();
            assert.equal(f.disposed.length, 0);
            if (cancel) {
                f.sandbox.discardActiveTerrainTileBuild('terrain-window-shifted');
                await f.flush();
                assert.equal(f.disposed.length, 1);
                assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
                assert.equal(f.sandbox.terrainTileBuildFailures.size, 0);
                assert.equal(f.step(), false);
            }
            boundary.publishReady();
            assert.equal((await road.promise).status, 'published');
            if (!cancel) {
                assert.equal(f.step(), true);
                await f.flush();
                assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
                boundary.publishReady();
                await f.flush();
                assert.notEqual(f.sandbox.tiles.get('0_0'), f.previous);
                assert.equal(f.sandbox.tiles.get('0_0').userData.terrainGpuPrepared, true);
                assert.equal(f.disposed.length, 1, 'only the old active root retires');
            }
            assert.equal(boundary.snapshot().pending, 0);
        } finally { f.close(); }
    });
}

test('a terminal compiler state failure retains the tile backlog without a synchronous failure loop', () => {
    const f = fixture();
    const error = Object.assign(new Error('terrain state unavailable'), { code: 'state-rejected' });
    let attempts = 0, warnings = 0, rejectedWaiters = 0;
    f.sandbox.renderCompiler.compile = () => { attempts++; throw error; };
    f.sandbox.console.error = () => { warnings++; };
    f.sandbox.rejectTerrainBuildWaiters = () => { rejectedWaiters++; };
    f.sandbox.pendingTileBuilds = Array.from({ length: 3000 }, (_, index) => ({ key: `${index}_0`, ring: index }));
    try {
        f.sandbox.pumpTerrainTileBuilds();
        assert.equal(attempts, 1);
        assert.equal(warnings, 1);
        assert.equal(rejectedWaiters, 1);
        assert.equal(f.sandbox.pendingTileBuilds.length, 3000);
        assert.equal(f.sandbox.terrainCompilerSnapshotFailure, error);
        for (let frame = 0; frame < 100; frame++) f.sandbox.pumpTerrainTileBuilds();
        assert.equal(attempts, 1, 'the next frame cannot start a retry/logging loop');
        assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
    } finally { f.close(); }
});

test('a late failure from an obsolete snapshot cannot block its replacement', async () => {
    const f = fixture();
    try {
        f.sandbox.pumpTerrainTileBuilds();
        f.sandbox.reference.revision = 2;
        f.rejectPacket(Object.assign(new Error('old snapshot failed'), { code: 'state-rejected' }));
        await f.flush();
        assert.equal(f.sandbox.terrainCompilerSnapshotFailure, null);
        f.installCompilerSnapshot();
        assert.equal(f.compileRequests.length, 2);
        assert.equal(f.compileRequests[1].inputs.snapshotRevision, 2);
        assert.equal(f.sandbox.terrainCompilerSnapshotFailure, null);
    } finally { f.close(); }
});

test('terrain keeps its previous mesh until queued packet checks and detached GPU preparation finish', async () => {
    const f = fixture();
    try {
        await f.start();
        assert.equal(f.jobs.length, 1);
        assert.equal(f.jobs[0].options.maxItemsPerFrame, 1);
        assert.equal(f.jobs[0].options.maxItemsPerSettledFrame, 1);
        assert.equal(f.published.length, 0, 'Worker resolution is not publication');
        for (let step = 0; step < 8; step++) f.step();
        assert.equal(f.published.length, 0);
        assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
        while (f.step()) {}
        await f.finishQuery();
        assert.equal(f.published.length, 0, 'completed GPU preparation still waits for the shared frame boundary');
        assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
        assert.equal(f.sandbox.groundPublications.snapshot().pending, 1);
        f.sandbox.groundPublications.publishReady();
        assert.ok(Math.abs(f.sandbox.publishedTerrain.sceneYAtLocal(10, 10) - 1) < 1e-10,
            'query changes at the same boundary as the mesh');
        await f.flush();
        assert.equal(f.published.length, 1);
        assert.equal(f.sandbox.tiles.get('0_0'), f.published[0]);
        assert.equal(f.published[0].children.length, 1);
        assert.equal(f.published[0].userData.terrainSurfaceSignature, 'current');
        assert.equal(f.published[0].userData.terrainGpuPrepared, true);
        assert.ok(f.shaders.length > 0);
        assert.ok(f.renders.length >= 2, 'the actual shared prewarm issues offscreen uploads before promotion');
    } finally { f.close(); }
});

test('cancelling terrain during shader polling frees geometry and retains its material until the fence', async () => {
    const f = fixture({ deferShaders: true });
    await f.start();
    while (!f.shaders.length) f.step();
    assert.equal(f.published.length, 0);
    assert.equal(f.renders.length, 0);
    f.sandbox.discardActiveTerrainTileBuild('shader-cancelled');
    await f.flush();
    assert.equal(f.disposed.length, 1, 'the detached root has already transferred out of the packet task');
    assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
    f.close();
    assert.equal(f.materialDisposals, 0, 'a pending compiler still owns the shared material program');
    f.shaders[0].resolve();
    await f.flush();
    assert.equal(f.materialDisposals, 1);
    assert.equal(f.published.length, 0);
});

for (const moment of ['mid-validation', 'after-queue-completion']) {
    test(`terrain cancellation ${moment} disposes the candidate without replacing the old mesh`, async () => {
        const f = fixture();
        try {
            await f.start(); f.step();
            if (moment === 'after-queue-completion') while (f.step()) {}
            f.sandbox.discardActiveTerrainTileBuild('superseded');
            await f.flush();
            assert.equal(f.published.length, 0);
            assert.equal(f.sandbox.tiles.get('0_0'), f.previous);
            assert.equal(f.jobs[0].complete, true);
            assert.deepEqual(f.discarded, ['superseded']);
            if (moment === 'after-queue-completion') {
                assert.equal(f.disposed.length, 1, 'the transferred result must not leak across the await gap');
                assert.equal(f.disposed[0], f.uploads[0].root);
            } else assert.throws(() => f.uploads[0].step(), /disposed/);
        } finally { f.close(); }
    });
}
