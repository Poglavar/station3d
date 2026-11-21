import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createRenderPacketUploadTask } from '../core/render-packet-three.js';
import { createFarBuildingPacketUploadTask, estimateFarBuildingUploadBytes } from '../core/far-building-packet-three.js';
import { createGeometryMemoryBudget, publishGeometryMemory, releaseGeometryMemory } from '../core/geometry-memory-budget.js';

function packet() {
    const primitive = (entityId, offset) => ({
        positions: new Float32Array([
            offset, 0, 0,
            offset + 1, 0, 0,
            offset, 0, 1,
        ]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
        materialKey: 'terrain',
        renderOrder: 2,
        bounds: {
            minX: offset, minY: 0, minZ: 0,
            maxX: offset + 1, maxY: 0, maxZ: 1,
        },
        entityRanges: [{ entityId, startIndex: 0, indexCount: 3 }],
        surfaceClaims: [{
            surfaceClass: 'terrain',
            coverageState: 'published',
            verticalRelation: 'same-level',
            supportReady: true,
        }],
        colliderData: null,
    });
    return {
        schemaVersion: 1,
        compilerId: 'test',
        compilerVersion: '1',
        sourceRevision: 'source:1',
        generation: 4,
        tile: {
            matrix: 'test', z: 0, x: 2, y: 3,
            originLon: 16, originLat: 45.8, sizeM: 10,
        },
        primitives: [primitive('a', 0), primitive('b', 2)],
    };
}

function largePacket() {
    const source = packet();
    source.primitives.length = 1;
    const primitive = source.primitives[0];
    const vertices = 24_000;
    primitive.positions = new Float32Array(vertices * 3);
    primitive.normals = new Float32Array(vertices * 3);
    primitive.uvs = new Float32Array(vertices * 2);
    primitive.indices = new Uint16Array([0, 1, vertices - 1]);
    return source;
}

for (const uploader of ['generic', 'far']) {
    test(`${uploader} uploader defers a late malformed buffer and creates no mesh before validation`, () => {
        const source = largePacket();
        source.primitives[0].positions[source.primitives[0].positions.length - 1] = NaN;
        const material = new THREE.MeshBasicMaterial();
        const options = { replacementKey: 'large:0', material, materialForKey: () => material };
        const task = uploader === 'generic'
            ? createRenderPacketUploadTask(source, options)
            : createFarBuildingPacketUploadTask(source, options);
        try {
            assert.equal(task.root.children.length, 0);
            assert.throws(() => task.result(), /incomplete/);
            for (let step = 0; step < 8; step++) {
                assert.equal(task.step(1), false, 'one step cannot scan the entire large primitive');
                assert.equal(task.root.children.length, 0, 'validation must precede resource allocation');
            }
            assert.throws(() => {
                for (let step = 0; step < 1000 && !task.done; step++) task.step(1);
            }, error => error.code === 'non-finite-position');
            assert.equal(task.root.children.length, 0);
            assert.throws(() => task.result(), /disposed/);
        } finally {
            task.dispose();
            material.dispose();
        }
    });
}

test('far packet memory sizing waits for malformed structure/collider validation', () => {
    for (const [mutate, code] of [
        [p => { p.primitives[0] = null; }, 'invalid-primitive'],
        [p => { p.primitives[0].positions = []; }, 'invalid-typed-array'],
        [p => { const cycle = {}; cycle.self = cycle; p.primitives[0].colliderData = cycle; }, 'cyclic-collider-data'],
    ]) {
        const source = packet(); mutate(source);
        const memoryBudget = createGeometryMemoryBudget({ nearBytes: 1, farBytes: 1 });
        const material = new THREE.MeshBasicMaterial();
        const task = createFarBuildingPacketUploadTask(source, { material, replacementKey: 'bad', memoryBudget });
        assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
        assert.throws(() => task.step(), error => error.code === code);
        assert.equal(task.root.children.length, 0);
        assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
        assert.equal(memoryBudget.snapshot().waiting.count, 0);
        material.dispose();
    }
});

test('packet upload is primitive-bounded and preserves picking/surface identity', () => {
    const material = new THREE.MeshBasicMaterial();
    const task = createRenderPacketUploadTask(packet(), {
        replacementKey: 'terrain:2:3',
        materialForKey: () => material,
        position: { x: 10, y: 0, z: 20 },
    });
    assert.equal(task.step(1), false);
    assert.equal(task.root.children.length, 1);
    assert.equal(task.step(1), true);
    const root = task.result();
    assert.equal(root.children.length, 2);
    assert.equal(root.position.x, 10);
    assert.equal(root.children[0].userData.entityRanges[0].key, 'a');
    assert.equal(root.children[0].userData.surfaceClaim.replacementKey, 'terrain:2:3');
    assert.equal(root.children[0].matrixAutoUpdate, false);
    for (const child of root.children) child.geometry.dispose();
    material.dispose();
});

test('cancelled upload disposes created geometry exactly once', () => {
    const material = new THREE.MeshBasicMaterial();
    let materialDisposeCalls = 0;
    material.addEventListener('dispose', () => { materialDisposeCalls += 1; });
    const task = createRenderPacketUploadTask(packet(), {
        replacementKey: 'terrain:2:3',
        materialForKey: () => material,
    });
    task.step(1);
    let disposeCalls = 0;
    task.root.children[0].geometry.addEventListener('dispose', () => { disposeCalls += 1; });
    assert.equal(task.dispose(), true);
    assert.equal(task.dispose(), false);
    assert.equal(disposeCalls, 1);
    assert.equal(materialDisposeCalls, 0, 'the layer owns its shared packet material');
    material.dispose();
});

test('far-building upload is primitive-bounded and batches picking identities', () => {
    const source = packet();
    source.compilerId = 'far-buildings';
    source.primitives = [
        ...source.primitives,
        structuredClone(source.primitives[0]),
    ].map((primitive, index) => ({
        ...primitive,
        materialKey: 'far-buildings',
        entityRanges: [{
            entityId: `building:${index}`,
            startIndex: 0,
            indexCount: primitive.indices.length,
            metadata: { objectId: `building:${index}`, nearKey: `${index}_0`, color: 0xaa8844 },
        }],
        surfaceClaims: [{
            surfaceClass: 'building',
            coverageState: 'published',
            verticalRelation: 'unknown',
        }],
    }));
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const configured = [];
    const task = createFarBuildingPacketUploadTask(source, {
        material,
        replacementKey: 'far-buildings:0_0',
        chunkSize: 2,
        position: { x: 800, y: 0, z: -800 },
        visibleForEntity: ref => ref.objectId !== 'building:1',
        configureBatch: batch => configured.push(batch),
    });
    assert.equal(task.step(1), false);
    assert.equal(task.root.children.length, 1);
    assert.equal(task.step(1), false);
    assert.equal(configured.length, 1, 'the first bounded batch closes at two primitives');
    assert.equal(task.step(1), true);
    const root = task.result();
    assert.equal(root.children.length, 2);
    assert.equal(root.position.x, 800);
    assert.equal(root.position.z, -800);
    assert.deepEqual(
        root.children.flatMap(batch => batch.userData.objectIdsByBatchId),
        ['building:0', 'building:1', 'building:2'],
    );
    assert.equal(root.children[0].userData.surfaceClaim.replacementKey, 'far-buildings:0_0');
    assert.equal(root.children[0].matrixAutoUpdate, false);
    for (const batch of root.children) {
        assert.equal(batch.sortObjects, false, 'opaque far batches skip per-frame sorting');
        assert.equal(batch.perObjectFrustumCulled, true);
        assert.ok(batch.boundingBox, 'aggregate bounds are ready before publication');
        assert.ok(batch.boundingSphere, 'aggregate sphere is ready before publication');
        assert.ok(Number.isFinite(batch.boundingSphere.radius));
        batch.dispose();
    }
    material.dispose();
});

test('far admission precedes BatchedMesh allocation and accounts actual typed backing storage', () => {
    const p = packet();
    const bytes = estimateFarBuildingUploadBytes(p, 1);
    const memoryBudget = createGeometryMemoryBudget({ nearBytes: 100, farBytes: bytes.backingCpuBytes + bytes.gpuBytes });
    const material = new THREE.MeshBasicMaterial();
    const first = createFarBuildingPacketUploadTask(p, { material, replacementKey: 'first', chunkSize: 1, memoryBudget });
    const second = createFarBuildingPacketUploadTask(p, { material, replacementKey: 'second', chunkSize: 1, memoryBudget });
    assert.equal(first.step(1), false);
    assert.equal(second.step(1), false);
    assert.equal(second.waitingForMemory, true);
    assert.equal(second.root.children.length, 0, 'denied work must allocate no BatchedMesh storage');
    assert.equal(first.step(1), true);
    assert.equal(memoryBudget.snapshot().source.cpuBytes, bytes.packetBytes, 'first packet source is released before publication');
    const root = first.result();
    let actualGpuBytes = 0, extraCpuBytes = 0;
    for (const batch of root.children) {
        actualGpuBytes += Object.values(batch.geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0)
            + batch.geometry.index.array.byteLength
            + batch._matricesTexture.image.data.byteLength
            + batch._indirectTexture.image.data.byteLength
            + batch._colorsTexture.image.data.byteLength;
        extraCpuBytes += batch._multiDrawCounts.byteLength + batch._multiDrawStarts.byteLength;
    }
    assert.equal(bytes.gpuBytes, actualGpuBytes, 'estimator matches the installed Three backing layout');
    assert.equal(bytes.backingCpuBytes, actualGpuBytes + extraCpuBytes);
    publishGeometryMemory(root);
    assert.equal(second.step(1), false);
    assert.equal(second.waitingForMemory, false, 'publication permits another candidate but keeps resident bytes counted');
    assert.equal(memoryBudget.snapshot().resident.count, 1);
    second.dispose();
    for (const batch of root.children) batch.dispose();
    releaseGeometryMemory(root);
    assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
    assert.equal(memoryBudget.snapshot().waiting.count, 0);
    material.dispose();
});

for (const stage of ['waiting', 'partial', 'failure']) {
    test(`far ${stage} cancellation/failure releases both packet and candidate ownership`, () => {
        const p = packet();
        const memoryBudget = createGeometryMemoryBudget({ nearBytes: 1, farBytes: 1 });
        const material = new THREE.MeshBasicMaterial();
        const task = createFarBuildingPacketUploadTask(p, {
            material, replacementKey: stage, chunkSize: 1, memoryBudget,
            configureBatch: stage === 'failure' ? () => { throw Error('preparation failed'); } : null,
        });
        if (stage === 'failure') assert.throws(() => task.step(1), /preparation failed/);
        else {
            if (stage === 'partial') task.step(1);
            task.dispose();
        }
        assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
        assert.equal(memoryBudget.snapshot().waiting.count, 0);
        assert.equal(task.root.children.length, 0);
        material.dispose();
    });
}

test('an empty far packet can return without an upload step and reserves no backing storage', () => {
    const source = packet(); source.primitives = [];
    const material = new THREE.MeshBasicMaterial();
    const memoryBudget = createGeometryMemoryBudget({ nearBytes: 1, farBytes: 1 });
    const task = createFarBuildingPacketUploadTask(source, { material, replacementKey: 'empty', memoryBudget });
    assert.equal(task.done, true);
    const root = task.result();
    publishGeometryMemory(root);
    assert.equal(root.children.length, 0);
    assert.equal(memoryBudget.snapshot().waiting.count, 0);
    assert.equal(memoryBudget.snapshot().source.count, 0);
    assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
    material.dispose();
});

test('a borrowed baked packet is accounted once and upload cleanup cannot release its cache owner', () => {
    const p = packet(), bytes = estimateFarBuildingUploadBytes(p, 1);
    const memoryBudget = createGeometryMemoryBudget({ nearBytes: 1, farBytes: bytes.backingCpuBytes + bytes.gpuBytes });
    const source = memoryBudget.trackSource({ lane: 'far', key: 'baked-tile', cpuBytes: bytes.packetBytes, gpuBytes: 0 });
    const material = new THREE.MeshBasicMaterial();
    const task = createFarBuildingPacketUploadTask(p, {
        material, replacementKey: 'borrowed', memoryBudget, chunkSize: 1,
        packetMemoryTrackedExternally: true,
    });
    assert.equal(memoryBudget.snapshot().source.count, 1);
    assert.equal(memoryBudget.snapshot().source.cpuBytes, bytes.packetBytes);
    task.step(1);
    task.dispose();
    assert.equal(memoryBudget.snapshot().estimatedBytes, bytes.packetBytes, 'cache outlives a cancelled borrower');
    source.release();
    assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
    material.dispose();
});
