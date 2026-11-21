// Verifies that GTA curb collision reuses bounded visible triangles and keeps
// the real curb-top elevation instead of replacing it with a tall wall.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { buildCurbSurfaceTrimeshData, buildCurbSurfaceTrimeshDataSteps } from '../core/gta-curb-surface.js';

test('local receiver origins do not turn invalid coordinates into physical faces', () => {
    for (const invalid of [null, undefined, true, '0', NaN, Infinity]) {
        for (const index of [0, 2, 3, 5, 6, 8]) {
            const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1];
            positions[index] = invalid;
            const data = buildCurbSurfaceTrimeshData({
                surfaces: [{ positions, originX: 100, originZ: 200 }],
                centerX: 100, centerZ: 200, radiusM: 20, maxTriangles: 1,
            });
            assert.equal(data.triangleCount, 0, `${String(invalid)} at coordinate ${index}`);
        }
    }
});

test('bounded curb collision retains the 18 cm face and excludes distant tiles', () => {
    const near = new Float32Array([
        -1, 0, 0, 1, 0, 0, 1, 0.18, 0,
        -1, 0, 0, 1, 0.18, 0, -1, 0.18, 0,
    ]);
    const far = new Float32Array([
        100, 0, 0, 102, 0, 0, 102, 0.18, 0,
    ]);
    const data = buildCurbSurfaceTrimeshData({
        surfaces: [{ positions: near }, { positions: far }],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
        maxTriangles: 8,
    });
    assert.equal(data.triangleCount, 2);
    assert.equal(data.truncated, false);
    assert.ok([...data.vertices].some(value => Math.abs(value - 0.18) < 1e-6));
    assert.ok([...data.vertices].every((value, index) => index % 3 !== 0 || value < 20));
});

test('curb collision reports truncation at its hard triangle cap', () => {
    const data = buildCurbSurfaceTrimeshData({
        surfaces: [{
            positions: new Float32Array([
                0, 0, 0, 1, 0, 0, 1, 0.18, 0,
                0, 0, 0, 1, 0.18, 0, 0, 0.18, 0,
            ]),
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
        maxTriangles: 1,
    });
    assert.equal(data.triangleCount, 1);
    assert.equal(data.truncated, true);
});

test('curb collision can subtract the physics origin without per-vertex objects', () => {
    const data = buildCurbSurfaceTrimeshData({
        surfaces: [{
            positions: new Float32Array([
                100, 2, 200, 102, 2, 200, 102, 2.18, 200,
            ]),
        }],
        centerX: 101,
        centerZ: 200,
        radiusM: 20,
        physicsOrigin: { x: 100, z: 200 },
        toPhysics: () => assert.fail('direct origin transform should avoid callbacks'),
        maxTriangles: 8,
    });
    assert.deepEqual([...data.vertices], [
        0, 2, 0,
        2, 2, 0,
        2, data.vertices[7], 0,
    ]);
    assert.ok(Math.abs(data.vertices[7] - 2.18) < 1e-5);
});

test('curb collision includes the visible raised-side support seam', () => {
    const curb = new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 0.18, 0,
    ]);
    const raisedSide = new Float32Array([
        0, 0.18, 0, 1, 0.18, 0, 1, 0.3, 1,
        0, 0.18, 0, 1, 0.3, 1, 0, 0.3, 1,
    ]);
    const data = buildCurbSurfaceTrimeshData({
        surfaces: [{
            positions: curb,
            additionalPositions: [raisedSide],
        }],
        centerX: 0,
        centerZ: 0,
        radiusM: 20,
        maxTriangles: 8,
    });

    assert.equal(data.triangleCount, 3);
    assert.ok([...data.vertices].some(value => Math.abs(value - 0.3) < 1e-6));
});

test('curb collision retains large floor and tangent wall support across the physics bubble boundary', async () => {
    const large = new Float32Array([-10, 0, -10, 10, 0, -10, 0, 0, 10]);
    const tangent = new Float32Array([1, 0, -2, 1, 0, 2, 1, 3, -2]);
    const far = new Float32Array([20, 0, 20, 21, 0, 20, 20, 0, 21]);
    const indexed = buildCurbSurfaceTrimeshData({ surfaces: [{
        positions: new Float32Array([...far, ...large]), indices: new Uint32Array([3,5,4]),
        additionalPositions: [new Float32Array([...far, ...tangent])], additionalIndices: [new Uint32Array([3,4,5])],
    }, {positions:far}], centerX: 0, centerZ: 0, radiusM: 1, maxTriangles: 8 });
    const expected = new Float32Array([...large.slice(0,3),...large.slice(6,9),...large.slice(3,6),...tangent]);
    const nonindexed = buildCurbSurfaceTrimeshData({ surfaces: [{ positions: expected }, { positions: far }],
        centerX: 0, centerZ: 0, radiusM: 1, maxTriangles: 8 });
    assert.equal(indexed.triangleCount, 2);
    assert.equal(nonindexed.triangleCount, 2);
    assert.deepEqual(indexed.vertices,expected);
    assert.deepEqual(indexed.vertices,nonindexed.vertices);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(expected,3));
    const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),mesh=new THREE.Mesh(geometry,material);
    mesh.updateMatrixWorld(true);
    await RAPIER.init();const world=new RAPIER.World({x:0,y:0,z:0});
    try {
        world.createCollider(RAPIER.ColliderDesc.trimesh(indexed.vertices,indexed.indices));world.step();
        for(const [origin,direction] of [[{x:0,y:2,z:0},{x:0,y:-1,z:0}],[{x:0,y:.5,z:0},{x:1,y:0,z:0}]]) {
            const visible=new THREE.Raycaster(new THREE.Vector3(origin.x,origin.y,origin.z),
                new THREE.Vector3(direction.x,direction.y,direction.z)).intersectObject(mesh)[0];
            const physical=world.castRay(new RAPIER.Ray(origin,direction),5,true);
            assert.ok(visible);assert.ok(physical);assert.ok(Math.abs(visible.distance-physical.timeOfImpact)<.001);
        }
    } finally {world.free();geometry.dispose();material.dispose();}
});

test('cooperative curb build yields on budget and cancels when stale', () => {
    let time = 0;
    let current = true;
    const steps = buildCurbSurfaceTrimeshDataSteps({
        surfaces: [{ positions: new Float32Array([
            0, 0, 0, 1, 0, 0, 1, 0.18, 0,
            0, 0, 0, 1, 0, 0, 1, 0.18, 0,
        ]) }], centerX: 0, centerZ: 0, radiusM: 20,
        now: () => (time += 1), isCurrent: () => current,
    });
    assert.equal(steps.next().done, false);
    current = false;
    assert.equal(steps.next().value, null);
});
