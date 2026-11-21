// Exercise the actual near aggregate drain/build/commit/disposal orchestration
// with real batch arrays and Three geometries; replace only surrounding I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { createGeometryMemoryBudget, bindGeometryMemory, publishGeometryMemory } from '../core/geometry-memory-budget.js';
import { createOwnerRangeRaycast } from '../core/owner-range-raycast.js';

const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
function world() {
    const memory = createGeometryMemoryBudget({ nearBytes: 100, farBytes: 100 });
    const batcher = createGeometryBatcher();
    const material = new THREE.MeshBasicMaterial();
    const descriptor = { material, renderOrder: 0, castShadow: false, receiveShadow: false };
    const c = vm.createContext({
        THREE, performance: { now: () => 0 }, buildingGeometryMemory: memory,
        createOwnerRangeRaycast,
        bindGeometryMemory, publishGeometryMemory, overtureBatcher: batcher,
        buildingsGroup: new THREE.Group(), overtureBucketDescriptors: new Map([['a', descriptor]]),
        overtureAggregates: new Map(), overtureAggregateEntityUnregister: new WeakMap(),
        facadeAtlasPageByMaterial: new WeakMap(), activeOvertureAssembly: null,
        pendingOvertureBuckets: [], pendingOvertureBucketSet: new Set(), pendingOvertureBucketHead: 0,
        OVERTURE_ASSEMBLY_VALUES_PER_STAGE: 32768, OVERTURE_ASSEMBLY_PARTS_PER_STAGE: 128,
        buildingAggregatePublicationGeneration: 0, surfacePublications: null,
        aggregateGate: { noteAssembled() {} }, recordLayerFrameMs() {},
        isWorldBuilding: () => true, isProposalBuildingBucketKey: () => false,
        setPassageAwareMaterial() {}, markSurfaceClaim() {}, publishPendingOverlayReplacements() {},
        SURFACE_CLASS: {}, SURFACE_COVERAGE_STATE: {}, SURFACE_VERTICAL_RELATION: {},
    });
    for (const name of ['buildOvertureAggregateMesh', 'commitOvertureAggregate', 'disposeOvertureAggregateMesh',
        'buildingAggregatePublicationKey', 'queueOvertureBucket', 'pendingOvertureBucketCount',
        'compactPendingOvertureBuckets', 'cancelOvertureAssembly', 'assembleOvertureBuckets']) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, name);
        vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), c);
    }
    const add = id => batcher.addPart('a', id, {
        attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    });
    const drain = () => { c.queueOvertureBucket('a'); c.assembleOvertureBuckets({ frameBudgetMs: Infinity, maxUploads: 1 }); };
    const cleanup = () => { c.cancelOvertureAssembly(); for (const { mesh } of c.overtureAggregates.values()) c.disposeOvertureAggregateMesh(mesh); material.dispose(); };
    return { c, memory, add, drain, cleanup };
}

test('real aggregate drain defers allocation, publishes byte-identical geometry and retains old until swap', () => {
    const w = world();
    w.add('one'); w.drain();
    const old = w.c.overtureAggregates.get('a').mesh;
    assert.deepEqual([...old.geometry.attributes.position.array], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.equal(w.memory.snapshot().resident.cpuBytes, 36);
    const hold = w.memory.request({ lane: 'near', key: 'another-candidate', cpuBytes: 80, gpuBytes: 0 });
    hold.tryAcquire();
    w.add('two'); w.drain();
    assert.equal(w.c.activeOvertureAssembly.task.lastPhase(), 'memory-wait');
    assert.equal(w.c.activeOvertureAssembly.task.result(), undefined);
    assert.equal(w.c.overtureAggregates.get('a').mesh, old);
    assert.equal(old.parent, w.c.buildingsGroup);
    let retired = 0; old.geometry.addEventListener('dispose', () => retired++);
    hold.release();
    w.c.assembleOvertureBuckets({ frameBudgetMs: Infinity, maxUploads: 1 });
    assert.equal(retired, 1);
    assert.equal(w.c.overtureAggregates.get('a').mesh.geometry.attributes.position.count, 6);
    assert.equal(w.memory.snapshot().resident.cpuBytes, 72);
    assert.equal(w.memory.snapshot().candidate.count, 0);
    assert.equal(w.memory.snapshot().oversizedAdmissions, 1);
    w.cleanup();
    assert.equal(w.memory.snapshot().estimatedBytes, 0);
});

test('stale waiting generation and explicit cancellation release reservations without retiring visible mesh', () => {
    const w = world(); w.add('one'); w.drain();
    const old = w.c.overtureAggregates.get('a').mesh;
    const hold = w.memory.request({ lane: 'near', key: 'hold', cpuBytes: 100, gpuBytes: 0 }); hold.tryAcquire();
    w.add('two'); w.drain();
    const previous = w.c.activeOvertureAssembly.task;
    w.add('three');
    w.c.assembleOvertureBuckets({ frameBudgetMs: Infinity, maxUploads: 1 });
    assert.notEqual(w.c.activeOvertureAssembly.task, previous);
    assert.throws(() => previous.step(), /cancelled/);
    assert.equal(w.memory.snapshot().waiting.count, 1);
    w.c.cancelOvertureAssembly(); hold.release();
    assert.equal(w.c.overtureAggregates.get('a').mesh, old);
    assert.equal(w.memory.snapshot().waiting.count, 0);
    w.cleanup();
    assert.equal(w.memory.snapshot().estimatedBytes, 0);
});

test('failed preparation disposes the unreturned geometry and keeps the old visible generation', () => {
    const w = world(); w.add('one'); w.drain();
    const old = w.c.overtureAggregates.get('a').mesh;
    let disposed = 0;
    w.c.bindGeometryMemory = (geometry, ticket, options) => {
        bindGeometryMemory(geometry, ticket, options);
        geometry.addEventListener('dispose', () => disposed++);
    };
    w.c.setPassageAwareMaterial = () => { throw Error('preparation failed'); };
    w.add('two');
    assert.throws(() => w.drain(), /preparation failed/);
    assert.equal(disposed, 1);
    assert.equal(w.c.activeOvertureAssembly, null);
    assert.equal(w.c.overtureAggregates.get('a').mesh, old);
    assert.equal(old.parent, w.c.buildingsGroup);
    assert.equal(w.memory.snapshot().candidate.count, 0);
    assert.equal(w.memory.snapshot().resident.cpuBytes, 36);
    w.cleanup();
    assert.equal(w.memory.snapshot().estimatedBytes, 0);
});
