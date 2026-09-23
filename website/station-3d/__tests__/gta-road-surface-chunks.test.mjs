import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { partitionRoadSurfaceMeshesSteps } from '../core/gta-road-surface-chunks.js';

await RAPIER.init();

function surface(count) {
    const vertices = new Float32Array(count * 9);
    const indices = new Uint32Array(count * 3);
    for (let n = 0; n < count; n++) {
        const v = n * 9;
        vertices.set([n, n + .1, 0, n + 1, n + .2, 0, n, n + .3, 1], v);
        indices.set([v / 3, v / 3 + 1, v / 3 + 2], n * 3);
    }
    return { vertices, indices };
}

function finish(generator) {
    let next;
    do next = generator.next(); while (!next.done);
    return next.value;
}

test('retains every triangle and partitions at the configured boundary', () => {
    const source = surface(8200);
    const meshes = finish(partitionRoadSurfaceMeshesSteps([source], { trianglesPerStep: 257 }));
    assert.deepEqual(meshes.map(mesh => mesh.triangleCount), [4096, 4096, 8]);
    let offset = 0;
    for (const mesh of meshes) {
        for (let n = 0; n < mesh.triangleCount; n++) {
            const a = n * 9;
            assert.deepEqual([...mesh.vertices.slice(a, a + 9)], [...source.vertices.slice(offset * 9, offset * 9 + 9)]);
            assert.deepEqual([...mesh.indices.slice(n * 3, n * 3 + 3)], [n * 3, n * 3 + 1, n * 3 + 2]);
            offset++;
        }
    }
});

test('rejects budget before allocating output meshes', () => {
    const source = surface(10);
    const generator = partitionRoadSurfaceMeshesSteps([source], { maxTriangles: 9 });
    assert.throws(() => generator.next(), /budget exceeded/);
});

test('admits budget before reading malformed trailing coordinates', () => {
    const source = surface(10);
    source.vertices[9] = NaN;
    assert.throws(() => partitionRoadSurfaceMeshesSteps([source], { maxTriangles: 9 }).next(), /budget exceeded/);
});

test('cancellation leaves source buffers unchanged', () => {
    const source = surface(300);
    const beforeVertices = source.vertices.slice();
    const beforeIndices = source.indices.slice();
    const generator = partitionRoadSurfaceMeshesSteps([source]);
    generator.next();
    generator.return();
    assert.deepEqual(source.vertices, beforeVertices);
    assert.deepEqual(source.indices, beforeIndices);
});

test('each chunk provides exact Rapier ray support across its boundary', () => {
    const source = surface(2);
    for (let n = 0; n < source.vertices.length; n += 3) source.vertices[n + 1] = 2;
    const meshes = finish(partitionRoadSurfaceMeshesSteps([source], { maxTrianglesPerMesh: 1 }));
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const colliders = meshes.map(mesh => {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        return world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices), body);
    });
    world.step();
    for (const x of [.2, 1.2]) {
        const hit = world.castRay(new RAPIER.Ray({ x, y: -100, z: .2 }, { x: 0, y: 1, z: 0 }), 200, true);
        assert.ok(hit, `ray at x=${x} should hit`);
        assert.ok(Math.abs(-100 + hit.timeOfImpact - 2) < 1e-3);
    }
    for (const collider of colliders) collider; // retain handles until world teardown
    world.free();
});

test('validation and copy both yield bounded work', () => {
    const yielded = [...partitionRoadSurfaceMeshesSteps([surface(300)], { trianglesPerStep: 128 })];
    assert.deepEqual(yielded.map(step => step.phase), ['road-surface-validation', 'road-surface-validation', 'road-surface-copy', 'road-surface-copy']);
});
