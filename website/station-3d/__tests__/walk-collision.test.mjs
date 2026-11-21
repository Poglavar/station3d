// Walk colliders are extracted from mesh transforms by reading raw matrix
// arrays (no `three` in node). These lock the decode — translation, scale and
// yaw — so a sign flip in the plain-array math can't silently wall off the
// wrong space or miss a wall in walk mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getWalkColliderBoxesNear,
    resetWalkColliders,
    resolveWalkMove,
    setWalkColliderSource,
    WALK_BODY_RADIUS_M,
} from '../world/walk-collision.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Column-major (three Matrix4.elements layout): yaw θ about Y, then translate.
function yawTranslate(theta, tx, ty, tz) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
}

// A single box mesh with an explicit world matrix + local bounding box.
function boxMesh(elements, min, max) {
    return {
        isMesh: true,
        visible: true,
        userData: {},
        isInstancedMesh: false,
        geometry: { type: 'BoxGeometry', boundingBox: { min, max }, computeBoundingBox() {} },
        matrixWorld: { elements },
    };
}

// A fresh uuid per source: the collider cache keys on group uuid + child count,
// so reusing one uuid across tests would serve a stale wall.
let _gid = 0;
function sourceOf(...meshes) {
    const group = {
        uuid: `g${_gid++}`, children: meshes,
        updateWorldMatrix() {},
        traverse(fn) { for (const m of meshes) fn(m); },
    };
    resetWalkColliders();
    setWalkColliderSource(() => [group]);
}

// A tall wall so it can't be stepped over (STEP_UP is 1.75 m); 4 m wide in X,
// thin (0.2 m) in Z — an oriented wall whose facing we can probe.
const WALL_MIN = { x: -2, y: 0, z: -0.1 };
const WALL_MAX = { x: 2, y: 4, z: 0.1 };

test('axis-aligned tall box blocks a walker crossing into it', () => {
    // Wall centred at z = 5, spanning x in [-2, 2].
    sourceOf(boxMesh([...IDENTITY.slice(0, 12), 0, 0, 5, 1], WALL_MIN, WALL_MAX));
    // Walk from just south of the wall straight through it.
    const r = resolveWalkMove(0, 4.4, 0, 5.6, 0);
    // Stopped on the near face, one body radius clear of z = 4.9 (the -Z face).
    assert.ok(r.z < 5 - 0.1, `expected blocked south of the wall, got z=${r.z}`);
    assert.ok(Math.abs(r.z - (4.9 - WALK_BODY_RADIUS_M)) < 0.05, `z=${r.z}`);
});

const near = (a, b) => Math.abs(a - b) < 1e-6;

test('a far-away walker is unaffected', () => {
    sourceOf(boxMesh([...IDENTITY.slice(0, 12), 0, 0, 5, 1], WALL_MIN, WALL_MAX));
    const r = resolveWalkMove(50, 50, 50, 50.2, 0);
    assert.ok(near(r.x, 50) && near(r.z, 50.2), `moved to ${r.x},${r.z}`);
});

test('yaw is decoded: a 90-deg-rotated wall blocks along its new normal', () => {
    // Same wall rotated 90 deg about Y and moved to x = 5: it now spans
    // z in [-2, 2] and is thin in X, so it blocks an EAST-bound walker.
    sourceOf(boxMesh(yawTranslate(Math.PI / 2, 5, 0, 0), WALL_MIN, WALL_MAX));
    const r = resolveWalkMove(4.4, 0, 5.6, 0, 0);
    assert.ok(r.x < 5 - 0.1, `expected blocked west of the rotated wall, got x=${r.x}`);
    // And a walker running parallel to it (north, well clear) passes freely.
    const parallel = resolveWalkMove(9, -1, 9, 1, 0);
    assert.ok(near(parallel.x, 9) && near(parallel.z, 1), `parallel to ${parallel.x},${parallel.z}`);
});

test('short boxes are steppable, not colliders', () => {
    // 0.5 m tall box: under the 1.75 m step-up, so the walker climbs it.
    sourceOf(boxMesh([...IDENTITY.slice(0, 12), 0, 0, 5, 1],
        { x: -2, y: 0, z: -0.1 }, { x: 2, y: 0.5, z: 0.1 }));
    const r = resolveWalkMove(0, 4.4, 0, 5.6, 0);
    assert.ok(near(r.x, 0) && near(r.z, 5.6), `climbed to ${r.x},${r.z}`);
});

test('GTA can reuse the authoritative nearby civil boxes with stable yaw', () => {
    sourceOf(
        boxMesh(yawTranslate(Math.PI / 2, 5, 1, 0), WALL_MIN, WALL_MAX),
        boxMesh(yawTranslate(0, 80, 1, 0), WALL_MIN, WALL_MAX),
    );
    const boxes = getWalkColliderBoxesNear(0, 0, 10, 10);
    assert.equal(boxes.length, 1);
    assert.ok(near(boxes[0].cx, 5));
    assert.ok(near(boxes[0].minY, 1));
    assert.ok(near(boxes[0].maxY, 5));
    assert.ok(near(Math.atan2(boxes[0].sin, boxes[0].cos), Math.PI / 2));
    assert.match(boxes[0].key, /^500:0:/);
});


test('collider extraction refreshes stale parent matrices after a floating-origin render', async () => {
    const THREE = await import('three');
    const { applyRenderOriginForRender, setSceneRenderOrigin, resetSceneRenderOrigin } = await import('../core/render-origin.js');
    const scene = new THREE.Scene(), group = new THREE.Group(), camera = new THREE.PerspectiveCamera();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(.4, 4, 6));
    wall.position.set(7.5, 2, 0); group.position.set(100, 0, 200);
    group.add(wall); scene.add(group);
    setSceneRenderOrigin(scene, { x: 5, z: -9 });
    applyRenderOriginForRender(scene, camera); scene.updateMatrixWorld(true);
    scene.onAfterRender();
    assert.equal(scene.position.x, 0);
    assert.equal(scene.matrixWorld.elements[12], -5, 'the render matrix intentionally still carries the prior origin');
    setWalkColliderSource(() => [group]);
    const [box] = getWalkColliderBoxesNear(107.5, 200, 10, 10);
    assert.equal(box.cx, 107.5); assert.equal(box.cz, 200);
    const clear = resolveWalkMove(101.8, 200, 104, 200, 0);
    assert.ok(near(clear.x, 104), 'the rendered open path cannot be blocked by a shifted wall');
    const blocked = resolveWalkMove(106, 200, 109, 200, 0);
    assert.ok(blocked.x < 107.5, 'the actual wall still blocks walking');
    resetSceneRenderOrigin(scene); resetWalkColliders(); setWalkColliderSource(null);
    wall.geometry.dispose(); wall.material.dispose();
});
