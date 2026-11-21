// Independent geometry and lifetime witnesses for the live curb tile compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { prepareCurbTileGeometrySteps } from '../core/curb-tile-geometry.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { captureAuthoredOpeningRegions } from '../core/surface-opening-shapes.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

const run = steps => { let next; do { next = steps.next(); } while (!next.done); return next.value; };
const tri = (positions = [], uvs = []) => ({ positions: Object.freeze(positions), uvs: Object.freeze(uvs) });
const profile = () => tri([0, 2, 0, 0, 2, 1, 1, 2, 0], [2, 3, 4, 5, 6, 7]);
const state = values => ({ tileKey: 'a', bounds: { minX: 0, maxX: 8, minZ: 0, maxZ: 8 },
    curb: profile(), ramp: tri(), greenRamp: tri(), terrainSeam: tri(), ...values });
const options = material => ({ materials: { curb: material, ramp: material, greenRamp: material, terrainSeam: material },
    uvPerM: { ramp: .4, greenRamp: .3, terrainSeam: .2 }, renderOrders: { curbRamp: 3, roadEarthwork: 4 } });
const floats = values => [...new Float32Array(values)];

test('known curb positions, normals and UVs retain the exact visible support buffer', () => {
    const input = state(), material = new THREE.MeshBasicMaterial();
    const output = run(prepareCurbTileGeometrySteps(input, options(material)));
    const mesh = output.root.children[0];
    assert.equal(mesh.name, 'CurbProfile'); assert.equal(mesh.userData.walkableSurface, true);
    assert.deepEqual([...mesh.geometry.attributes.position.array], input.curb.positions);
    assert.deepEqual([...mesh.geometry.attributes.uv.array], input.curb.uvs);
    assert.deepEqual([...mesh.geometry.attributes.normal.array], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
    assert.equal(output.collisionSurface.positions, mesh.geometry.attributes.position.array);
    assert.deepEqual(output.collisionSurface.additionalPositions, []);
    output.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(.25, 10, .25), new THREE.Vector3(0, -1, 0));
    assert.equal(ray.intersectObject(output.root)[0].point.y, 2);
    mesh.geometry.dispose(); material.dispose();
});

test('chunking preserves every profile and seam triangle; ramp winding and UV scales are explicit', () => {
    const material = new THREE.MeshBasicMaterial();
    const input = state({
        curb: tri([...profile().positions, ...profile().positions], [...profile().uvs, ...profile().uvs]),
        ramp: tri([0, 2, 0, 1, 2, 0, 0, 2, 1]),
        greenRamp: tri([2, 2, 3, 3, 2, 3, 2, 2, 4]),
        terrainSeam: tri([4, 2, 5, 5, 2, 5, 4, 2, 6]),
    });
    const before = JSON.stringify(input);
    const output = run(prepareCurbTileGeometrySteps(input, { ...options(material), maxVertices: 3 }));
    const meshes = output.root.children;
    assert.equal(meshes.length, 5);
    for (const mesh of meshes) assert.equal(mesh.geometry.attributes.position.count, 3);
    const expectedUvs = { CurbRamp: [0, 0, 0, .4, .4, 0],
        CurbGreenRamp: [.6, .9, .6, 1.2, .9, .9], CurbTerrainSeam: [.8, 1, .8, 1.2, 1, 1] };
    for (const [name, expected] of Object.entries(expectedUvs)) {
        const mesh = meshes.find(mesh => mesh.name === name), p = mesh.geometry.attributes.position.array;
        assert.deepEqual([...mesh.geometry.attributes.uv.array], floats(expected));
        assert.ok((p[5] - p[2]) * (p[6] - p[0]) - (p[3] - p[0]) * (p[8] - p[2]) > 0);
        assert.deepEqual([...mesh.geometry.attributes.normal.array], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
    }
    assert.equal(output.collisionSurface.positions, meshes[0].geometry.attributes.position.array);
    assert.equal(output.collisionSurface.additionalPositions.length, 2);
    assert.equal(output.collisionSurface.additionalPositions[0], meshes[1].geometry.attributes.position.array);
    assert.equal(output.collisionSurface.additionalPositions[1], meshes[4].geometry.attributes.position.array);
    assert.equal(JSON.stringify(input), before);
    for (const mesh of meshes) mesh.geometry.dispose(); material.dispose();
});

test('each triangle consults the budget, and stale/returned/failed candidates release geometry once', () => {
    const originalDispose = THREE.BufferGeometry.prototype.dispose;
    const disposed = new Set(); let materialDisposals = 0;
    THREE.BufferGeometry.prototype.dispose = function () {
        assert.equal(disposed.has(this), false); disposed.add(this); originalDispose.call(this);
    };
    const material = new THREE.MeshBasicMaterial(); material.addEventListener('dispose', () => materialDisposals++);
    try {
        let time = 0, current = true;
        const input = state({ curb: tri([...profile().positions, ...profile().positions], [...profile().uvs, ...profile().uvs]) });
        const steps = prepareCurbTileGeometrySteps(input, { ...options(material), now: () => time++, isCurrent: () => current });
        assert.equal(steps.next().value.phase, 'curb-mesh-attributes');
        assert.equal(steps.next().value.phase, 'curb-mesh-attributes');
        assert.equal(steps.next().value.phase, 'curb-mesh-chunk');
        current = false; assert.equal(run(steps), null); assert.equal(disposed.size, 1);
        const returned = prepareCurbTileGeometrySteps(state(), options(material));
        while (returned.next().value?.phase !== 'curb-mesh-chunk') {}
        returned.return(); assert.equal(disposed.size, 2);
        const failed = prepareCurbTileGeometrySteps(state({ manholes: profile() }), { ...options(material),
            buildManholeMesh() { throw new Error('manhole assembly failed'); } });
        assert.throws(() => run(failed), /manhole assembly failed/); assert.equal(disposed.size, 3);
        assert.equal(materialDisposals, 0);
        assert.equal(run(prepareCurbTileGeometrySteps(state(), { ...options(material), isCurrent: () => false })), null);
    } finally { THREE.BufferGeometry.prototype.dispose = originalDispose; material.dispose(); }
});

test('manhole factory calls receive bounded complete triangles', () => {
    const material = new THREE.MeshBasicMaterial(), lengths = [];
    const output = run(prepareCurbTileGeometrySteps(state({ manholes: {
        positions: [...profile().positions, ...profile().positions], uvs: [...profile().uvs, ...profile().uvs] } }), {
        ...options(material), maxVertices: 3, buildManholeMesh(data) {
            lengths.push([data.positions.length, data.uvs.length]); return null;
        },
    }));
    assert.deepEqual(lengths, [[9, 6], [9, 6]]);
    output.root.children[0].geometry.dispose(); material.dispose();
});

test('curb, ramp, seam and manhole triangles share an opening with actual Rapier, including a retained lintel', () => {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const openingRead = run(createSurfaceOpeningReadSteps({ authored: captureAuthoredOpeningRegions([
        { minX: -1, maxX: 1, minZ: -2, maxZ: 2, minY: -2, maxY: 2 }], 1),
        limits: { maxRegions: 4, maxSourceVertices: 32, maxCandidates: 4, maxFragments: 128 } }));
    const plane = [-5, 1, -1, -5, 1, 1, 5, 1, -1, 5, 1, -1, -5, 1, 1, 5, 1, 1];
    const wall = [-5, 0, 0, 5, 0, 0, -5, 3, 0, -5, 3, 0, 5, 0, 0, 5, 3, 0];
    const data = p => tri(p, p.flatMap((v, i) => i % 3 === 1 ? [] : [v]));
    const input = state({ curb: data([...plane, ...wall]), ramp: data(plane), greenRamp: data(plane),
        terrainSeam: data(plane), manholes: data(plane), bounds: { minX: -5, maxX: 5, minZ: -2, maxZ: 2 } });
    const before = JSON.stringify(input);
    const make = (openings) => run(prepareCurbTileGeometrySteps(input, { ...options(material), openingRead: openings,
        openingClaim: { surfaceClass: SURFACE_CLASS.ROAD_DRESSING }, buildManholeMesh(data) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, material); mesh.name = 'Manholes'; return mesh;
        } }));
    const clipped = make(openingRead), uncut = make(null);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const ray = (root, x, y, z, dx = 0, dy = -1, dz = 0) => {
        root.updateMatrixWorld(true);
        return new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz)).intersectObject(root);
    };
    try {
        assert.equal(JSON.stringify(input), before);
        const profile = clipped.root.getObjectByName('CurbProfile');
        assert.equal(clipped.collisionSurface.positions, profile.geometry.attributes.position.array);
        assert.equal(clipped.collisionSurface.indices, profile.geometry.index.array);
        assert.equal(uncut.collisionSurface.indices, null);
        assert.equal(uncut.root.getObjectByName('CurbProfile').geometry.index, null);
        for (const name of ['CurbProfile', 'CurbRamp', 'CurbGreenRamp', 'CurbTerrainSeam', 'Manholes']) {
            const mesh = clipped.root.getObjectByName(name);
            assert.ok(mesh, name);
            assert.equal(mesh.geometry.attributes.normal.count, mesh.geometry.attributes.position.count,
                `${name} keeps every interpolated vertex attribute`);
            assert.equal(ray(mesh, 0, 1.5, .5).length, 0, `${name} leaves the floor opening`);
            assert.equal(ray(mesh, 3, 1.5, .5)[0].point.y, 1, `${name} retains adjacent receiver`);
        }
        assert.ok(ray(profile, 0, 2.5, 4, 0, 0, -1).length, 'the lintel stays above the opening ceiling');
        assert.equal(ray(profile, 0, 1.5, 4, 0, 0, -1).length, 0, 'the wall opening is physical too');
        const data = buildCurbSurfaceTrimeshData({ surfaces: [clipped.collisionSurface],
            centerX: 0, centerZ: 0, radiusM: 20 });
        assert.equal(data.truncated, false);
        world.createCollider(RAPIER.ColliderDesc.trimesh(data.vertices, data.indices)); world.step();
        const physical = (x, y, z, dx = 0, dy = -1, dz = 0) => world.castRay(
            new RAPIER.Ray({ x, y, z }, { x: dx, y: dy, z: dz }), 10, true);
        assert.equal(physical(0, 1.5, .5), null, 'no invisible support closes the floor opening');
        assert.ok(Math.abs(physical(3, 1.5, .5).timeOfImpact - .5) < .001);
        assert.ok(Math.abs(physical(0, 2.5, 4, 0, 0, -1).timeOfImpact - 4) < .001);
        assert.equal(physical(0, 1.5, 4, 0, 0, -1), null);
    } finally {
        for (const output of [clipped, uncut]) output.root.traverse(mesh => mesh.geometry?.dispose());
        world.free(); material.dispose();
    }
});
