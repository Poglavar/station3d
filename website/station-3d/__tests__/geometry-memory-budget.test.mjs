// Lock real admission, old/new lifetimes and progress under pressure; byte
// accounting alone is not the behavior these tests are meant to protect.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    createGeometryMemoryBudget, bindGeometryMemory, publishGeometryMemory,
} from '../core/geometry-memory-budget.js';
import { createGeometryBatcher } from '../core/geometry-batch.js';

const budget = () => createGeometryMemoryBudget({ nearBytes: 100, farBytes: 100 });
const request = (b, key, bytes, lane = 'near') => b.request({ lane, key, cpuBytes: bytes, gpuBytes: 0 });

test('candidate admission waits, then publication frees overlap allowance but retains live bytes', () => {
    const b = budget();
    const old = request(b, 'old', 70);
    assert.equal(old.tryAcquire(), true);
    old.publish();
    const candidate = request(b, 'new', 70);
    assert.equal(candidate.tryAcquire(), true, 'the old visible generation cannot deadlock its replacement');
    const waiting = request(b, 'other', 40);
    assert.equal(waiting.tryAcquire(), false);
    assert.equal(b.snapshot().estimatedBytes, 140);
    candidate.publish();
    assert.equal(b.snapshot().resident.cpuBytes, 140);
    assert.equal(waiting.tryAcquire(), true);
    old.release(); candidate.release(); waiting.release(); waiting.release();
    assert.equal(b.snapshot().estimatedBytes, 0);
    assert.equal(b.snapshot().waiting.count, 0);
});

test('far reservations cannot consume near progress; oversized work is exclusive and reported', () => {
    const b = budget();
    const far = request(b, 'far', 150, 'far');
    assert.equal(far.tryAcquire(), true);
    const near = request(b, 'near', 80);
    assert.equal(near.tryAcquire(), true);
    const far2 = request(b, 'far2', 1, 'far');
    assert.equal(far2.tryAcquire(), false);
    assert.equal(b.snapshot().oversizedAdmissions, 1);
    assert.equal(b.snapshot().lanes.far.candidateCount, 1);
    assert.equal(b.snapshot().lanes.far.admissions, 1);
    assert.equal(b.snapshot().lanes.near.admissions, 1);
    assert.equal(b.snapshot().lanes.far.waits, 1);
    assert.equal(b.snapshot().lanes.far.oversizedAdmissions, 1);
    far.release();
    assert.equal(far2.tryAcquire(), true);
    near.release(); far2.release();
});

test('a waiting large request cannot be starved by later small requests, and cancellation frees its place', () => {
    const b = budget();
    const active = request(b, 'active', 80); active.tryAcquire();
    const large = request(b, 'large', 90);
    const small = request(b, 'small', 10);
    assert.equal(large.tryAcquire(), false);
    assert.equal(small.tryAcquire(), false);
    large.release();
    assert.equal(small.tryAcquire(), true);
    active.release(); small.release();
});

test('incoming source bytes are retained separately from pre-allocation reservations', () => {
    const b = budget();
    const source = b.trackSource({ lane: 'far', key: 'packet', cpuBytes: 400, gpuBytes: 0 });
    const upload = request(b, 'upload', 80, 'far');
    assert.equal(b.snapshot().source.cpuBytes, 400);
    assert.equal(b.snapshot().waiting.cpuBytes, 80);
    assert.equal(b.snapshot().estimatedBytes, 400, 'waiting allocations do not already exist');
    assert.equal(upload.tryAcquire(), true);
    source.release(); upload.release();
    assert.equal(b.snapshot().estimatedBytes, 0);
});

test('actual geometry disposal releases its published reservation, not mere detachment', () => {
    const b = budget();
    const r = request(b, 'mesh', 80); r.tryAcquire();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const group = new THREE.Group(); group.add(mesh);
    bindGeometryMemory(mesh.geometry, r, { disposeEvent: true });
    publishGeometryMemory(mesh.geometry);
    group.remove(mesh);
    assert.equal(b.snapshot().resident.cpuBytes, 80);
    mesh.geometry.dispose(); mesh.geometry.dispose();
    assert.equal(b.snapshot().estimatedBytes, 0);
});

test('assembly consults admission before allocating, yields even at Infinity, and resumes byte-identically', () => {
    const batcher = createGeometryBatcher();
    batcher.addPart('bucket', 'owner', {
        attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
        index: new Uint16Array([0, 1, 2]),
    });
    let allowed = false;
    const estimates = [];
    const task = batcher.beginAssembly('bucket', { admitBytes: bytes => { estimates.push(bytes); return allowed; } });
    assert.equal(task.step(Infinity), false);
    assert.equal(task.lastPhase(), 'memory-wait');
    assert.equal(task.result(), undefined);
    assert.deepEqual(estimates, [48], 'output indices are Uint32 regardless of input type');
    allowed = true;
    assert.equal(task.step(Infinity), true);
    assert.deepEqual(task.result(), batcher.assemble('bucket'));
    task.cancel();
    assert.equal(task.result(), undefined);
    assert.equal(task.isCurrent(), false);
    assert.throws(() => task.step(), /cancelled/);
});

test('invalid budgets and byte estimates fail explicitly', () => {
    assert.throws(() => createGeometryMemoryBudget({ nearBytes: 0, farBytes: 1 }), /allowance/);
    const b = budget();
    for (const bytes of [-1, NaN, Infinity, null]) assert.throws(() => request(b, 'bad', bytes), /estimate/);
    const waiting = request(b, 'waiting', 1);
    assert.throws(() => waiting.publish(), /admitted/);
    waiting.release();
    assert.throws(() => waiting.tryAcquire(), /released/);
});
