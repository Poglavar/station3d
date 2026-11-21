// Check clipped world-space geometry independently against the original Three
// meshes and opening footprint, then query the actual captured Rapier faces.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { clipReceiverMeshOpeningsSteps } from '../core/receiver-mesh-openings.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';

await RAPIER.init();
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const caps = { maxObjects: 100, maxVertices: 10000, maxTriangles: 10000, maxGeometryBytes: 2 * 1024 ** 2 };
const claim = { surfaceClass: 'terrain', coverageState: 'published', verticalRelation: 'same-level', replacementKey: null };
const readFor = regions => drain(createSurfaceOpeningReadSteps({ authored: regions, limits: GROUND_GENERATION_LIMITS.openings }));
const boxRegion = (minX, minZ, maxX, maxZ, minY = -10, maxY = 10, replacementKey = null) => ({
    ring: [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }],
    minY, maxY, maxYExclusive: false, replacementKey,
});
function makePlane() {
    const geometry = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2).rotateY(.2).translate(1, 0, 2);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    material.userData.surfaceClaim = claim;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(2, .5, -1); mesh.rotation.set(0, .3, .12); mesh.scale.set(1.2, 1, .8);
    mesh.updateWorldMatrix(true, true);
    return mesh;
}
const clip = (mesh, read, extra = {}) => drain(clipReceiverMeshOpeningsSteps({
    mesh, worldMatrix: mesh.matrixWorld, openingRead: read, ...caps, ...extra,
}));
const rayY = (mesh, x, z, ceiling = 8) => new THREE.Raycaster(new THREE.Vector3(x, ceiling, z),
    new THREE.Vector3(0, -1, 0)).intersectObject(mesh)[0]?.point.y ?? null;
function physicalRead(mesh) {
    const read = drain(captureReceiverMeshReadSteps({ root: mesh, include: () => true, revision: 1, ...caps }));
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const colliders = read.surfaces.map(surface => { const mesh = buildCurbSurfaceTrimeshData({ surfaces: [surface], centerX: 0, centerZ: 0, radiusM: 1000, physicsOrigin: { x: 0, z: 0 } }); return world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices)); });
    return { read, world, at(x, z, ceiling = 8) {
        const ray = new RAPIER.Ray({ x, y: ceiling, z }, { x: 0, y: -1, z: 0 });
        let best = null;
        for (const collider of colliders) {
            const distance = collider.castRay(ray, 20, true);
            if (Number.isFinite(distance) && distance >= 0 && distance <= 20) best = Math.max(best ?? -Infinity, ceiling - distance);
        }
        return best;
    } };
}
function sameHeight(actual, expected, label) {
    assert.equal(actual === null, expected === null, label);
    if (expected !== null) assert.ok(Math.abs(actual - expected) < .001, `${label}: ${actual} != ${expected}`);
}

test('transformed indexed and nonindexed cuts agree with independent Three, point-query and Rapier support', () => {
    const opening = readFor([boxRegion(1, -1, 3, 1, -2, 2)]);
    for (const indexed of [false, true]) {
        const mesh = makePlane();
        if (!indexed) { const previous = mesh.geometry; mesh.geometry = previous.toNonIndexed(); previous.dispose(); }
        const source = mesh.geometry.attributes.position.array.slice(), matrix = mesh.matrixWorld.elements.slice();
        let out, physical;
        try {
            out = clip(mesh, opening); assert.notEqual(out, mesh); out.updateWorldMatrix(true, true);
            assert.deepEqual(mesh.geometry.attributes.position.array, source);
            assert.deepEqual(mesh.matrixWorld.elements, matrix); assert.equal(out.material, mesh.material);
            physical = physicalRead(out);
            let removed = 0, retained = 0;
            // Avoid only the <=1 mm inclusive boundary band. The independent
            // rectangle oracle does not call the clipping implementation.
            for (let x = -.913; x < 5; x += .37) for (let z = -1.823; z < 4; z += .41) {
                if (Math.min(Math.abs(x - 1), Math.abs(x - 3), Math.abs(z + 1), Math.abs(z - 1)) <= .001) continue;
                const original = rayY(mesh, x, z);
                const inside = original !== null && x > 1 && x < 3 && z > -1 && z < 1 && original > -2 && original < 2;
                const expected = inside ? null : original;
                if (inside) removed++; else if (original !== null) retained++;
                const label = `indexed=${indexed} x=${x} z=${z}`;
                sameHeight(rayY(out, x, z), expected, `Three ${label}`);
                sameHeight(physical.read.supportYAt(x, z, { maxY: 8 }), expected, `captured ${label}`);
                sameHeight(physical.at(x, z), expected, `Rapier ${label}`);
            }
            assert.ok(removed > 10 && retained > 10, `${removed} cut / ${retained} retained samples`);
            // UVs/normals are interpolated on the source-local plane, including
            // newly introduced cut vertices, despite the world-space transform.
            const uv = out.geometry.attributes.uv, p = out.geometry.attributes.position;
            const inverseGeometryRotation = new THREE.Matrix4().makeRotationY(-.2);
            for (let index = 0; index < p.count; index++) {
                const local = new THREE.Vector3().fromBufferAttribute(p, index).sub(new THREE.Vector3(1, 0, 2))
                    .applyMatrix4(inverseGeometryRotation);
                assert.ok(Math.abs(uv.getX(index) - (local.x / 4 + .5)) < 1e-6);
                assert.ok(Math.abs(uv.getY(index) - (.5 - local.z / 4)) < 1e-6);
                const n = new THREE.Vector3().fromBufferAttribute(out.geometry.attributes.normal, index);
                assert.ok(Math.abs(n.y - 1) < 1e-6);
            }
        } finally { physical?.world.free(); out?.geometry.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
    }
});

test('a clipped instance batch stays one draw and preserves complete physical side boxes', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshBasicMaterial();
    material.userData.surfaceClaim = claim;
    const mesh = new THREE.InstancedMesh(geometry, material, 3);
    for (const [index, x] of [-3, 0, 3].entries()) mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(x, 0, 0));
    mesh.updateWorldMatrix(true, true);
    const matrices = mesh.instanceMatrix.array.slice(), source = geometry.attributes.position.array.slice();
    let out, physical;
    try {
        out = clip(mesh, readFor([boxRegion(-.25, -1, .25, 1, -2, 2)]));
        out.updateWorldMatrix(true, true); physical = physicalRead(out);
        assert.equal(out.isMesh, true); assert.equal(out.isInstancedMesh, undefined); assert.equal(out.children.length, 0);
        assert.deepEqual(mesh.instanceMatrix.array, matrices); assert.deepEqual(geometry.attributes.position.array, source);
        assert.equal(out.material, material); assert.ok(out.geometry.attributes.normal && out.geometry.attributes.uv);
        for (const x of [-3, -.4, 0, .4, 3]) {
            const expected = x === 0 ? null : .5;
            sameHeight(rayY(out, x, 0), expected, `Three box x=${x}`);
            sameHeight(physical.read.supportYAt(x, 0), expected, `captured box x=${x}`);
            sameHeight(physical.at(x, 0), expected, `Rapier box x=${x}`);
        }
    } finally { physical?.world.free(); out?.geometry.dispose(); geometry.dispose(); material.dispose(); }
});

test('distant and own replacement cuts preserve resources; rejected or cancelled cuts leave source intact', () => {
    const mesh = makePlane(), source = mesh.geometry.attributes.position.array.slice();
    let disposals = 0; mesh.geometry.addEventListener('dispose', () => disposals++);
    try {
        assert.equal(clip(mesh, readFor([boxRegion(100, 100, 101, 101)])), mesh);
        mesh.userData.surfaceClaim = { ...claim, replacementKey: 'own' };
        assert.equal(clip(mesh, readFor([boxRegion(1, -1, 3, 1, -2, 2, 'own')])), mesh);
        assert.throws(() => clip(mesh, readFor([boxRegion(-5, -5, 5, 5)]), { maxTriangles: 1 }), /capacity/);
        let active = true;
        const steps = clipReceiverMeshOpeningsSteps({ mesh, worldMatrix: mesh.matrixWorld,
            openingRead: readFor([boxRegion(-5, -5, 5, 5)]), ...caps, now: () => 1, isCurrent: () => active });
        assert.equal(steps.next().done, false); active = false;
        assert.throws(() => steps.next(), { code: 'ground-generation-stale' });
        assert.deepEqual(mesh.geometry.attributes.position.array, source); assert.equal(disposals, 0);
    } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
});

test('world-to-local boundary interpolation yields and cancels before exposing a replacement', () => {
    const mesh = makePlane(), before = mesh.geometry.attributes.position.array.slice();
    let active = true, clock = 0;
    const steps = clipReceiverMeshOpeningsSteps({ mesh, worldMatrix: mesh.matrixWorld,
        openingRead: readFor([boxRegion(1, -1, 3, 1, -2, 2)]), ...caps,
        now: () => clock += .3, isCurrent: () => active });
    try {
        let reached = false;
        for (let count = 0; count < 10000; count++) {
            const next = steps.next(); assert.equal(next.done, false, 'local interpolation needs its own bounded visit');
            if (next.value.phase === 'receiver-opening-local-provenance') { reached = true; break; }
        }
        assert.equal(reached, true); active = false;
        assert.throws(() => steps.next(), { code: 'ground-opening-stale' });
        assert.deepEqual(mesh.geometry.attributes.position.array, before);
    } finally { steps.return(); mesh.geometry.dispose(); mesh.material.dispose(); }
});
