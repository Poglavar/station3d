// Captured support uses the actual faces at the queried level, and a combined
// publication cannot hide changes or removal behind another producer's revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { createReceiverSupportQuerySteps, composeReceiverSupportReads, composeReceiverSupportReadsSteps,
    EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';

await RAPIER.init();
const run = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const capture = (root, revision = 1) => run(captureReceiverMeshReadSteps({ root, revision,
    include: () => true, maxObjects: 100, maxVertices: 10000, maxTriangles: 10000 }));
const box = (x, y, z, w, h, l) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), new THREE.MeshBasicMaterial());
    mesh.position.set(x, y, z); return mesh;
};
const dispose = root => root.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });

test('support distinguishes floor, thin step, ceiling and upper deck using actual Three and Rapier faces', () => {
    const root = new THREE.Group();
    root.add(box(0, -.1, 0, 8, .2, 8), box(0, 3, 0, 8, .2, 8), box(0, .001, 0, .08, .002, 8));
    root.position.set(7, 12, -9); root.rotation.y = .37; root.updateMatrixWorld(true);
    const read = capture(root), data = buildCurbSurfaceTrimeshData({ surfaces: read.surfaces,
        centerX: 7, centerZ: -9, radiusM: 100 });
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(data.vertices, data.indices));
    try {
        for (const [localX, ceiling] of [[0, 13], [.1, 13], [0, 14.95], [0, 16], [0, 11.7]]) {
            const p = new THREE.Vector3(localX, 0, 0).applyMatrix4(root.matrixWorld);
            const ray = new THREE.Raycaster(new THREE.Vector3(p.x, ceiling, p.z), new THREE.Vector3(0, -1, 0));
            const actual = ray.intersectObject(root)[0]?.point.y ?? null;
            const value = read.supportYAt(p.x, p.z, { maxY: ceiling });
            assert.equal(value === null, actual === null);
            if (actual !== null) assert.ok(Math.abs(value - actual) < 1e-6, `${value} != ${actual}`);
            // Rapier is two-sided. Stay outside solids when comparing floors;
            // the query above separately proves an underside is not a floor.
            if (ceiling === 14.95) continue;
            const impact = collider.castRay(new RAPIER.Ray({ x: p.x, y: ceiling, z: p.z },
                { x: 0, y: -1, z: 0 }), 10, true);
            const hit = Number.isFinite(impact) && impact >= 0 && impact <= 10;
            assert.equal(value === null, !hit);
            if (hit) assert.ok(Math.abs(value - (ceiling - impact)) < .001);
        }
        assert.ok(read.supportYAt(7, -9, { maxY: 13 }) > 12.0019, 'the two-millimetre step is physical support');
        for (const maxY of [null, NaN, -Infinity]) assert.equal(read.supportYAt(7, -9, { maxY }), null);
        assert.equal(read.supportYAt(1000, 1000), null);
    } finally { world.free(); dispose(root); }
});

test('point-query density rejects before publication and index construction is cancellable', () => {
    const root = box(0, 0, 0, 10, 1, 10), read = capture(root);
    try {
        assert.throws(() => run(createReceiverSupportQuerySteps(read.surfaces, { maxPointCandidates: 1 })),
            { code: 'ground-generation-capacity' });
        let clock = 0, current = true;
        const steps = createReceiverSupportQuerySteps(read.surfaces, { now: () => clock++, isCurrent: () => current });
        for (;;) {
            const next = steps.next(); assert.equal(next.done, false);
            if (next.value.phase === 'bounds-grid-index') break;
        }
        current = false;
        assert.throws(() => run(steps), { code: 'ground-generation-stale' });
        assert.equal(read.supportYAt(0, 0), .5, 'a rejected successor leaves the captured read intact');
    } finally { dispose(root); }
});

test('combined readers retain unchanged identity and advance on changes to older producers and removal', () => {
    const root = box(0, 0, 0, 4, 2, 4);
    try {
        const a = capture(root, 100); root.position.y = 3;
        const b = capture(root, 1), first = composeReceiverSupportReads(undefined, [a, b]);
        assert.equal(first.supportYAt(0, 0), 4);
        assert.equal(first.supportYAt(0, 0, { maxY: 2 }), 1);
        assert.equal(composeReceiverSupportReads(first, [a, b]), first);
        root.position.y = 4;
        const revised = composeReceiverSupportReads(first, [a, capture(root, 2)]);
        assert.equal(revised.revision, first.revision + 1); assert.equal(revised.supportYAt(0, 0), 5);
        const removed = composeReceiverSupportReads(revised, [a]);
        assert.equal(removed.revision, revised.revision + 1); assert.equal(removed.supportYAt(0, 0), 1);
        const empty = composeReceiverSupportReads(removed, []);
        assert.equal(empty.revision, removed.revision + 1); assert.equal(empty.supportYAt(0, 0), null);
        assert.deepEqual(empty.surfacesNear(0, 0, 10), []);
        assert.equal(first.supportYAt(0, 0), 4, 'older readers retain their source set');
        assert.equal(composeReceiverSupportReads(EMPTY_RECEIVER_SUPPORT_READ, []), EMPTY_RECEIVER_SUPPORT_READ);
    } finally { dispose(root); }
});

test('one aggregate query visits nearby captured faces without calling any producer query', () => {
    const roots = [], reads = [], touches = new Map();
    try {
        for (let i = 0; i < 64; i++) {
            const root = box(i * 100, i % 4, 0, 4, 2, 4); roots.push(root);
            root.updateMatrixWorld(true);
            const read = capture(root), surfaces = read.surfaces.map(surface => Object.freeze({ ...surface,
                positions: new Proxy(surface.positions, { get(target, key) {
                    if (/^\d+$/.test(String(key))) touches.set(i, (touches.get(i) || 0) + 1);
                    return Reflect.get(target, key, target);
                } }),
            }));
            reads.push(Object.freeze({ revision: i + 1, surfaces: Object.freeze(surfaces),
                supportYAt() { assert.fail('aggregate scanned a producer'); },
                surfacesNear() { assert.fail('aggregate scanned a producer for collision'); } }));
        }
        const aggregate = run(composeReceiverSupportReadsSteps(undefined, reads));
        touches.clear();
        const actual = new THREE.Raycaster(new THREE.Vector3(300, 10, 0), new THREE.Vector3(0, -1, 0))
            .intersectObjects(roots, true)[0].point.y;
        assert.equal(aggregate.supportYAt(300, 0, { maxY: 10 }), actual);
        assert.deepEqual([...touches.keys()], [3], 'distant receiver buffers were not read');
        assert.equal(aggregate.supportYAt(350, 0, { maxY: 10 }), null, 'the real gap stays unsupported');
        assert.deepEqual(aggregate.surfacesNear(300, 0, 10), reads[3].surfaces);
        const expected = reads.flatMap(read => read.surfaces).filter(({ bounds }) =>
            Math.max(bounds.minX - 300, 0, 300 - bounds.maxX) ** 2
                + Math.max(bounds.minZ, 0, -bounds.maxZ) ** 2 <= 260 ** 2);
        assert.deepEqual(aggregate.surfacesNear(300, 0, 260), expected, 'collider order matches the complete source order');
    } finally { roots.forEach(dispose); }
});

test('combined and nested receiver density, index storage and cancellation retain the previous read', () => {
    const root = box(0, 0, 0, 4, 2, 4);
    try {
        const a = capture(root), first = composeReceiverSupportReads(undefined, [a], { maxPointCandidates: 2 });
        root.position.y = 3; const b = capture(root, 2);
        assert.equal(b.supportYAt(0, 0), 4, 'the second producer independently fits its own query');
        for (const sources of [[a, b], [first, b]]) {
            assert.throws(() => run(composeReceiverSupportReadsSteps(first, sources, { maxPointCandidates: 2 })),
                { code: 'ground-generation-capacity' });
        }
        const duplicate = composeReceiverSupportReads(undefined, [first, a], { maxPointCandidates: 2 });
        assert.equal(duplicate.usage.faces, 2, 'the same captured surface is indexed once across nested sources');
        assert.deepEqual(duplicate.surfacesNear(0, 0, 10), a.surfaces);
        assert.equal(first.usage.indexEntries, 8, 'two upward faces touch four 8 m cells');
        assert.equal(first.usage.regionIndexEntries, 4, 'one collider surface touches the same four cells');
        for (const previous of [undefined, first]) {
            assert.throws(() => composeReceiverSupportReads(previous, [a], { maxIndexEntries: 11 }),
                { code: 'ground-generation-capacity' });
        }
        for (const options of [{ maxFaces: 1 }, { maxSources: 1 }, { maxSurfaces: 1 }]) {
            assert.throws(() => composeReceiverSupportReads(first, [a, b], options),
                { code: 'ground-generation-capacity' });
        }
        for (const phase of ['receiver-support-sources', 'receiver-support-surfaces', 'bounds-grid-index']) {
            let current = true, now = 0;
            const steps = composeReceiverSupportReadsSteps(first, [a, b], { now: () => now += .6, isCurrent: () => current });
            for (;;) {
                const next = steps.next(); assert.equal(next.done, false);
                if (next.value.phase === phase) break;
            }
            current = false;
            assert.throws(() => run(steps), { code: 'ground-generation-stale' });
            assert.equal(first.supportYAt(0, 0), 1);
        }
    } finally { dispose(root); }
});

test('the actual world entry publishes the shared read atomically and restores it after a later failure', () => {
    const source = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
    const captureBlock = (start, end) => {
        const from = source.indexOf(start), to = source.indexOf(end, from);
        assert.ok(from >= 0 && to > from, `Missing production publication block: ${start}`);
        return source.slice(from, to);
    };
    const block = captureBlock('        const previousOpenings =', '        const proposalMask =')
        + captureBlock('        const previousAuthoredRead =', '        const openingTerrainLayers =');
    const GeneratorFunction = Object.getPrototypeOf(function*() {}).constructor;
    const prepare = GeneratorFunction('ctx', 'openingSupport', 'structures', 'openings', 'composeReceiverSupportReadsSteps',
        'keep', 'metadata', 'limits', 'sourceCurrent', block);
    const root = box(0, 0, 0, 4, 2, 4), registry = createSurfacePublicationRegistry();
    const oldOpenings = Object.freeze({ contains: () => false }), nextOpenings = Object.freeze({ contains: () => true });
    const old = composeReceiverSupportReads(undefined, [capture(root)]), ctx = { authoredSurfaceRead: old, surfaceOpeningRead: oldOpenings };
    root.position.y = 3; const next = capture(root, 2);
    root.position.set(10, 6, 0); const structureRead = capture(root, 3);
    try {
        for (const failure of [true, false]) {
            const entries = [];
            run(prepare(ctx, [next], { supportRead: structureRead }, nextOpenings, composeReceiverSupportReadsSteps, resource => resource, (key, resource) => {
                entries.push({ ticket: registry.begin({ key, generation: failure ? 1 : 2 }), clear: true,
                    isCurrent: resource.isCurrent, commit: resource.commit, rollback: resource.rollback });
            }, {}, () => true));
            const batch = registry.prepareBatch(entries, { commit() { if (failure) throw Error('later physics failed'); } });
            assert.equal(ctx.authoredSurfaceRead, old);
            assert.equal(ctx.surfaceOpeningRead, oldOpenings);
            if (failure) {
                assert.throws(() => batch.publish(), /later physics failed/);
                assert.equal(ctx.authoredSurfaceRead, old); assert.equal(ctx.authoredSurfaceRead.supportYAt(0, 0), 1);
                assert.equal(ctx.authoredSurfaceRead.supportYAt(10, 0), null);
                assert.equal(ctx.surfaceOpeningRead, oldOpenings);
            } else {
                assert.equal(batch.publish().status, 'published');
                assert.equal(ctx.authoredSurfaceRead.sources[0], next); assert.equal(ctx.authoredSurfaceRead.supportYAt(0, 0), 4);
                assert.equal(ctx.authoredSurfaceRead.sources[1], structureRead);
                assert.equal(ctx.authoredSurfaceRead.supportYAt(10, 0), 7);
                assert.equal(ctx.surfaceOpeningRead, nextOpenings);
            }
        }
    } finally { registry.close(); dispose(root); }
});
