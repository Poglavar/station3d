// Exercises the actual deferred rail dressing builders and queue adapter:
// preserved geometry, bounded work, stale-job rejection and resource ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import * as formation from '../core/road-formation.js';
import * as windows from '../core/render-budgets.js';
import { trianglePositionChunkRanges } from '../core/triangle-geometry-chunks.js';
import { SURFACE_RENDER_ORDER, GROUND_SURFACE_LEVELS } from '../core/surface-hierarchy.js';
import { disposeGroup } from '../core/dispose.js';
import { dressingProfiles } from './fixtures/rail-dressing-profiles.mjs';

const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const section = (a, b) => {
    const start = source.indexOf(a), end = source.indexOf(b, start);
    assert.ok(start >= 0 && end > start, `${a}…${b}`);
    return source.slice(start, end);
};
const hash = values => createHash('sha256').update(JSON.stringify(Array.from(values))).digest('hex');
const meshEvidence = root => root.children.map(mesh => ({ name: mesh.name,
    count: mesh.geometry.attributes.position.count,
    positions: hash(mesh.geometry.attributes.position.array),
    uvs: hash(mesh.geometry.attributes.uv.array), normals: hash(mesh.geometry.attributes.normal.array),
    boxes: hash(mesh.userData.walkColliderBoxes || []), renderOrder: mesh.renderOrder,
}));

function runtime(overrides = {}) {
    const jobs = [], times = [], materials = [], geometries = [];
    class Material extends THREE.MeshStandardMaterial {
        constructor(options) { super(options); this.disposals = 0; materials.push(this); }
        dispose() { this.disposals++; super.dispose(); }
    }
    class Geometry extends THREE.BufferGeometry {
        constructor() { super(); this.disposals = 0; geometries.push(this); }
        dispose() { this.disposals++; super.dispose(); }
    }
    const repeat = Symbol('repeat');
    const queue = { enqueue(items, process, options) {
        const job = { item: items[0], process, options, complete: false }; jobs.push(job); return job;
    }, cancel(job) { if (!job.complete) { job.complete = true; job.options.onCancel(); } } };
    const context = vm.createContext({ THREE: { ...THREE, MeshStandardMaterial: Material, BufferGeometry: Geometry },
        ...formation, ...windows, trianglePositionChunkRanges, SURFACE_RENDER_ORDER,
        TRACKBED_Y: GROUND_SURFACE_LEVELS.tramBed, RAIL_WALL_WINDOW_PADDING_M: 40,
        RAIL_DRESSING_CHUNK_MAX_VERTICES: 24_000, RAIL_EARTHWORK_CLAIM: {},
        getCutConcreteSurface: () => ({ map: null, bumpMap: null }),
        getActiveTerrainSurface: () => ({ map: null, bumpMap: null, bumpScale: 0, uvPerM: .5 }),
        applySurfaceStencil() {}, applyGroundOwnership() {}, applyPlannerSurfaceCutout() {}, applyUrbanGroundSurface() {},
        railDressingQueue: null, pendingRailVisualRefresh: null, railSessionToken: 1,
        groundManaged: false,
        performance: { now: () => 0 }, recordLayerFrameMs: (...args) => times.push(args),
        FRAME_CHUNK_REPEAT_ITEM: repeat,
        createFrameChunkQueue(options) { queue.options = options; return queue; }, ...overrides,
    });
    vm.runInContext(section('function* addRailDressingMeshChunksSteps(', 'function segmentWithinRenderWindow(')
        + section('function* createRailFormationDressingSteps(', 'function createRailStructuresGroup(')
        + section('function ensureRailDressingQueue(', 'function ensureRailRetirementQueue('), context);
    const step = job => {
        if (job.complete) return;
        try {
            if (job.process(job.item) !== repeat) { job.complete = true; job.options.onComplete(); }
        } catch (error) { job.complete = true; job.options.onError(error); }
    };
    const drain = job => { for (let n = 0; !job.complete; n++) { assert.ok(n < 100_000); step(job); } };
    return { context, jobs, times, materials, geometries, queue, step, drain };
}

function enqueue(r, profiles = dressingProfiles(), coordinatedDressing = false) {
    const target = new THREE.Group();
    let current = true;
    const railFormation = { getSurfaceProfiles: () => profiles };
    const refresh = { centerX: 0, centerZ: 0, coordinatedDressing, ground: { railFormation, isCurrent: () => current } };
    r.context.pendingRailVisualRefresh = refresh;
    r.context.enqueueRailDressingPreparation(refresh, target, { maxRadiusM: 150, readyProperty: 'ready' });
    return { target, refresh, job: r.jobs.at(-1), stale() { current = false; } };
}

test('actual queued dressing matches independent frozen v31 mesh and collider outputs', () => {
    const r = runtime(), profiles = dressingProfiles(), before = JSON.stringify(profiles);
    const { target, refresh, job } = enqueue(r, profiles);
    const scene = new THREE.Scene(), old = new THREE.Group(); scene.add(old);
    assert.equal(target.children.length, 0, 'enqueue performs no geometry work');
    assert.equal(r.queue.options.frameBudgetMs, 1);
    assert.equal(job.options.maxItemsPerFrame, undefined, 'the shared time budget controls frame throughput');
    let visits = 0;
    while (!job.complete) {
        r.step(job); visits++;
        assert.equal(target.parent, null);
        assert.equal(scene.children[0], old, 'the old generation stays attached throughout preparation');
        if (!job.complete) assert.equal(refresh.ready, undefined);
    }
    assert.ok(visits > 100, 'large profiles actually suspend inside their loops');
    assert.equal(refresh.ready, true);
    assert.equal(refresh.dressingBuildJob, null);
    assert.equal(JSON.stringify(profiles), before);
    const expected = JSON.parse(readFileSync(new URL('./fixtures/rail-dressing-before-scheduling.json', import.meta.url)));
    assert.deepEqual(meshEvidence(target), expected.meshes);
    assert.ok(target.children.every(mesh => mesh.geometry.attributes.position.count <= 24_000));
    disposeGroup(target);
    assert.ok(r.materials.every(material => material.disposals === 1));
    assert.ok(r.geometries.every(geometry => geometry.disposals === 1));
});

test('managed refresh advances the same builder directly and preserves frozen output', () => {
    const r = runtime({ groundManaged: true });
    const profiles = dressingProfiles(), { target, refresh } = enqueue(r, profiles, true);
    assert.equal(r.jobs.length, 0, 'managed mode does not create a queue job');
    assert.equal(target.parent, null);
    for (let visits = 0; refresh.ready !== true; visits++) {
        assert.ok(visits < 100_000, 'managed preparation must converge');
        r.context.enqueueRailDressingPreparation(refresh, target, { maxRadiusM: 150, readyProperty: 'ready' });
        assert.equal(target.parent, null);
    }
    const expected = JSON.parse(readFileSync(new URL('./fixtures/rail-dressing-before-scheduling.json', import.meta.url)));
    assert.deepEqual(meshEvidence(target), expected.meshes);
    disposeGroup(target);
    assert.ok(r.materials.every(material => material.disposals === 1));
    assert.ok(r.geometries.every(geometry => geometry.disposals === 1));
});

test('managed mode uses the same 64-step and elapsed work bound, and stale cancellation closes it', () => {
    for (const elapsedPerRead of [0, .3]) for (const invalidate of ['ground', 'session', 'replacement']) {
        let time = 0, steps = 0, closed = false;
        const r = runtime({ performance: { now: () => time += elapsedPerRead } });
        r.context.createRailFormationDressingSteps = function* () {
            try { for (;;) { steps++; yield { phase: 'test' }; } } finally { closed = true; }
        };
        const pending = enqueue(r, dressingProfiles(), true);
        assert.equal(steps, elapsedPerRead ? 1 : 64);
        assert.equal(r.jobs.length, 0); assert.equal(pending.refresh.ready, undefined);
        if (invalidate === 'ground') pending.stale();
        if (invalidate === 'session') r.context.railSessionToken++;
        if (invalidate === 'replacement') r.context.pendingRailVisualRefresh = {};
        r.context.enqueueRailDressingPreparation(pending.refresh, pending.target, { maxRadiusM: 150, readyProperty: 'ready' });
        assert.equal(closed, true); assert.equal(pending.refresh.ready, undefined);
        assert.equal(pending.refresh.dressingBuild, null);
        assert.equal(pending.refresh.dressingBuildSession, null);
    }
});

test('cancellation before the first mesh frees its new material without changing the visible scene', () => {
    let time = 0;
    const r = runtime({ performance: { now: () => time += .3 } });
    const { target, refresh, job } = enqueue(r);
    while (r.materials.length === 0) r.step(job);
    assert.equal(target.children.length, 0);
    r.context.cancelRailDressingPreparation(refresh);
    assert.equal(job.complete, true);
    assert.equal(refresh.ready, undefined);
    assert.equal(refresh.dressingBuild, null);
    assert.deepEqual(r.materials.map(material => material.disposals), [1]);
});

test('each queue callback has a fixed work cap and also yields to its elapsed-time budget', () => {
    for (const elapsedPerRead of [0, .3]) {
        let time = 0, steps = 0, closed = false;
        const r = runtime({ performance: { now: () => time += elapsedPerRead } });
        r.context.createRailFormationDressingSteps = function* () {
            try { for (;;) { steps++; yield { phase: 'test' }; } }
            finally { closed = true; }
        };
        const { job, refresh } = enqueue(r);
        r.step(job);
        assert.equal(steps, elapsedPerRead ? 1 : 64);
        assert.equal(job.complete, false);
        r.context.cancelRailDressingPreparation(refresh);
        assert.equal(closed, true);
        assert.equal(refresh.ready, undefined);
    }
});

test('stale or changed sessions close a partially built candidate and never mark it ready', () => {
    for (const invalidate of ['ground', 'session', 'replacement']) {
        const r = runtime(), pending = enqueue(r);
        while (pending.target.children.length === 0) r.step(pending.job);
        if (invalidate === 'ground') pending.stale();
        if (invalidate === 'session') r.context.railSessionToken++;
        if (invalidate === 'replacement') r.context.pendingRailVisualRefresh = {};
        r.drain(pending.job);
        assert.equal(pending.refresh.ready, undefined);
        assert.equal(pending.refresh.dressingBuild, null);
        disposeGroup(pending.target);
        assert.ok(r.materials.every(material => material.disposals === 1));
        assert.ok(r.geometries.every(geometry => geometry.disposals === 1));
    }
});

test('a geometry exception releases unattached resources and reaches the refresh error gate', () => {
    const r = runtime();
    r.context.THREE.BufferGeometry.prototype.computeVertexNormals = () => { throw Error('invalid mesh'); };
    const { target, refresh, job } = enqueue(r);
    r.drain(job);
    assert.match(refresh.dressingError.message, /invalid mesh/);
    assert.equal(refresh.ready, undefined);
    assert.equal(target.children.length, 0);
    assert.deepEqual(r.materials.map(material => material.disposals), [1]);
    assert.deepEqual(r.geometries.map(geometry => geometry.disposals), [1]);
    assert.equal(r.jobs.length, 1, 'the queue does not retry a failed item');
});

test('startup and explicit rebuilds schedule the same deferred path and preserve the active generation', () => {
    const r = runtime({ lastFeatures: [], lastRenderCenterX: 1, lastRenderCenterZ: 2 });
    const previous = { reason: 'streamed', streamedSignature: 'r7', streamedInputRevision: 7 };
    r.context.pendingRailVisualRefresh = previous;
    let discarded;
    r.context.discardPendingRailVisualRefresh = () => { discarded = r.context.pendingRailVisualRefresh; };
    vm.runInContext(section('function rebuildVisibleRails(', 'function railInspectionSpecForName('), r.context);
    assert.equal(r.context.rebuildVisibleRails(50, 60), true);
    assert.equal(discarded, previous);
    assert.deepEqual(JSON.parse(JSON.stringify(r.context.pendingRailVisualRefresh)), {
        centerX: 50, centerZ: 60, reason: 'streamed', streamedSignature: 'r7', streamedInputRevision: 7 });
    assert.equal(r.jobs.length, 0, 'world scheduling does not run a builder synchronously');
});
