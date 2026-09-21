import { resolveWalkCameraPose } from '../core/walk-camera.js';

// Solid walls for walk mode. Station and civil geometry (hall walls, tunnel
// trench walls, mezzanine guard rails, stair-well and entrance walls) is
// reduced once per session to upright boxes; the walker is a circle that slides
// along them instead of passing through.
//
// Two things are deliberately NOT colliders:
//   • anything the walker can stand on (walkableSurface) or step onto — treads,
//     curbs, platform edges stay climbable exactly as before;
//   • buildings — walking into one still lifts you onto its roof, which is the
//     behaviour the sim has always had and the one we want to keep.

// No `three` import: this module only needs the raw numeric data off the meshes
// it's handed (matrixWorld.elements, instanceMatrix.array, geometry.boundingBox
// min/max), so it does the matrix math on plain arrays. That keeps the pure
// collision logic loadable + testable under node, where `three` (browser-only,
// via the import map) can't resolve.

export const WALK_BODY_RADIUS_M = 0.35;
const BODY_TOP_M = 1.7;
const FOOT_CLEARANCE_M = 0.25;
// Matches cab.js's ground-detection step-up: anything you could stand on top of
// is climbed, not collided with.
const STEP_UP_M = 1.75;
const MIN_WALL_HEIGHT_M = 0.25;
const MAX_SUBSTEP_M = 0.3;

let colliders = null;
let colliderGrid = null;
let colliderSignature = '';
let sourceGroupsFn = null;
// Broadphase: colliders are static once built, so they are bucketed into a
// uniform grid and only the buckets around the walker are ever tested.
const GRID_CELL_M = 8;

// Column-major 4x4 multiply (matches three's Matrix4.elements layout):
// returns a 16-element array = a * b.
function mat4Multiply(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4]
                + a[4 + r] * b[c * 4 + 1]
                + a[8 + r] * b[c * 4 + 2]
                + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

// The scene is rebuilt per cab session; drop the cached boxes with it.
export function setWalkColliderSource(getGroups) {
    sourceGroupsFn = typeof getGroups === 'function' ? getGroups : null;
    colliders = null;
}

export function resetWalkColliders() {
    colliders = null;
    colliderGrid = null;
    colliderSignature = '';
}

// me is a 16-element column-major matrix (a Matrix4.elements-shaped array).
function pushCollider(out, mesh, me, boundingBox) {
    // Basis columns carry the rotation * scale; their lengths are the scale.
    const scaleX = Math.hypot(me[0], me[1], me[2]);
    const scaleY = Math.hypot(me[4], me[5], me[6]);
    const scaleZ = Math.hypot(me[8], me[9], me[10]);
    if (scaleX < 1e-9 || scaleY < 1e-9 || scaleZ < 1e-9) return;
    // Only yaw-aligned boxes become colliders. Sloped members (stair handrails
    // built between two points) would need a real OBB and are not worth it. A
    // pure yaw leaves the Y basis vertical, so a tilt shows up as a horizontal
    // component on the normalised Y column (~0.06 ≈ the old |quat.x/z| > 0.03).
    if (Math.abs(me[4] / scaleY) > 0.06 || Math.abs(me[6] / scaleY) > 0.06) return;
    const sizeY = (boundingBox.max.y - boundingBox.min.y) * scaleY;
    if (sizeY < MIN_WALL_HEIGHT_M) return;
    const sizeX = (boundingBox.max.x - boundingBox.min.x) * scaleX;
    const sizeZ = (boundingBox.max.z - boundingBox.min.z) * scaleZ;
    if (sizeX < 0.02 || sizeZ < 0.02) return;
    // Box centre in local space, transformed by the matrix (w = 1).
    const lx = (boundingBox.min.x + boundingBox.max.x) * 0.5;
    const ly = (boundingBox.min.y + boundingBox.max.y) * 0.5;
    const lz = (boundingBox.min.z + boundingBox.max.z) * 0.5;
    const centerX = me[0] * lx + me[4] * ly + me[8] * lz + me[12];
    const centerY = me[1] * lx + me[5] * ly + me[9] * lz + me[13];
    const centerZ = me[2] * lx + me[6] * ly + me[10] * lz + me[14];
    // Yaw straight off the normalised X basis: three's RotationY gives
    // column0 = (cosθ, 0, -sinθ), so cos = me[0]/scaleX, sin = -me[2]/scaleX.
    const cos = me[0] / scaleX;
    const sin = -me[2] / scaleX;
    out.push({
        cx: centerX,
        cz: centerZ,
        hx: sizeX * 0.5,
        hz: sizeZ * 0.5,
        sin,
        cos,
        minY: centerY - sizeY * 0.5,
        maxY: centerY + sizeY * 0.5,
        // Guards are short enough to step onto but must still stop the walker,
        // otherwise a mezzanine handrail is a suggestion rather than a barrier.
        guard: mesh.userData?.guard === true,
        reach: Math.hypot(sizeX, sizeZ) * 0.5 + WALK_BODY_RADIUS_M,
        ...(mesh.userData?.groundColliderFamily ? { groundColliderFamily: mesh.userData.groundColliderFamily,
            groundColliderState: mesh.userData.groundColliderState } : {}),
    });
}

function collectGroup(group, out) {
    // Rendering temporarily translates the scene root. Restore ancestor world
    // matrices as well as this subtree before caching absolute CPU colliders.
    group.updateWorldMatrix(true, true);
    group.traverse(object => {
        if (!object.isMesh) return;
        if (object.userData?.walkableSurface === true) return;
        if (object.visible === false) return;
        const explicit = object.userData?.walkColliderBoxes;
        if (Array.isArray(explicit)) {
            for (const collider of explicit) {
                if (![collider.cx, collider.cz, collider.hx, collider.hz,
                    collider.sin, collider.cos, collider.minY, collider.maxY]
                    .every(Number.isFinite)) continue;
                out.push({
                    ...collider,
                    ...(object.userData?.groundColliderFamily ? { groundColliderFamily: object.userData.groundColliderFamily,
                        groundColliderState: object.userData.groundColliderState } : {}),
                    guard: collider.guard === true,
                    reach: Number.isFinite(collider.reach)
                        ? collider.reach
                        : Math.hypot(collider.hx, collider.hz) + WALK_BODY_RADIUS_M,
                });
            }
            return;
        }
        const geometry = object.geometry;
        // Boxes only. A tapered prism or a whole-line viaduct deck would
        // collide as its bounding box and wall off the space around it.
        if (!geometry || geometry.type !== 'BoxGeometry') return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const boundingBox = geometry.boundingBox;
        if (!boundingBox) return;
        const worldElements = object.matrixWorld.elements;
        if (object.isInstancedMesh) {
            const arr = object.instanceMatrix.array;
            for (let i = 0; i < object.count; i++) {
                // getMatrixAt(i) is just this slice of the instance buffer; the
                // world matrix folds in the mesh's own transform.
                const instance = arr.slice(i * 16, i * 16 + 16);
                pushCollider(out, object, mat4Multiply(worldElements, instance), boundingBox);
            }
            return;
        }
        pushCollider(out, object, worldElements, boundingBox);
    });
}

function cellKey(x, z) {
    return `${Math.floor(x / GRID_CELL_M)}|${Math.floor(z / GRID_CELL_M)}`;
}

function buildGrid(list) {
    const grid = new Map();
    for (const collider of list) {
        const minX = collider.cx - collider.reach;
        const maxX = collider.cx + collider.reach;
        const minZ = collider.cz - collider.reach;
        const maxZ = collider.cz + collider.reach;
        for (let x = Math.floor(minX / GRID_CELL_M); x <= Math.floor(maxX / GRID_CELL_M); x++) {
            for (let z = Math.floor(minZ / GRID_CELL_M); z <= Math.floor(maxZ / GRID_CELL_M); z++) {
                const key = `${x}|${z}`;
                const bucket = grid.get(key);
                if (bucket) bucket.push(collider);
                else grid.set(key, [collider]);
            }
        }
    }
    return grid;
}

// Layers stream in and station geometry is rebuilt as the walker travels, so
// the box list follows the scene rather than a clock: each source group's
// identity and child count is a cheap signature, and only a change to it
// triggers a rebuild.
function sceneSignature(groups) {
    let signature = '';
    for (const group of groups) {
        signature += group ? `${group.uuid}:${group.children.length}:${group.userData?.walkCollisionRevision || 0}|` : '-|';
    }
    return signature;
}

function ensureColliders() {
    const groups = sourceGroupsFn ? (sourceGroupsFn() || []) : [];
    const signature = sceneSignature(groups);
    if (colliders && signature === colliderSignature) return colliders;
    const built = [];
    for (const group of groups) {
        if (group) collectGroup(group, built);
    }
    colliders = built;
    colliderGrid = buildGrid(built);
    colliderSignature = signature;
    return colliders;
}

function blocksWalker(collider, feetY) {
    if (collider.maxY <= feetY + FOOT_CLEARANCE_M) return false;
    if (collider.minY >= feetY + BODY_TOP_M) return false;
    if (!collider.guard && collider.maxY <= feetY + STEP_UP_M) return false;
    return true;
}

// Circle vs box in the box's own frame: returns the depenetrated position, or
// null when the walker is already clear of it. The tangential part of the move
// survives, which is what makes the walker slide along a wall instead of
// sticking to it.
function depenetrate(collider, x, z) {
    const dx = x - collider.cx;
    const dz = z - collider.cz;
    let localX = dx * collider.cos - dz * collider.sin;
    let localZ = dx * collider.sin + dz * collider.cos;
    const clampedX = Math.max(-collider.hx, Math.min(collider.hx, localX));
    const clampedZ = Math.max(-collider.hz, Math.min(collider.hz, localZ));
    const offsetX = localX - clampedX;
    const offsetZ = localZ - clampedZ;
    const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
    if (distanceSq > WALK_BODY_RADIUS_M * WALK_BODY_RADIUS_M) return null;
    if (distanceSq > 1e-8) {
        const distance = Math.sqrt(distanceSq);
        const push = WALK_BODY_RADIUS_M - distance;
        localX += (offsetX / distance) * push;
        localZ += (offsetZ / distance) * push;
    } else {
        // Dead centre inside the box — leave by the nearest face.
        const penetrationX = collider.hx + WALK_BODY_RADIUS_M - Math.abs(localX);
        const penetrationZ = collider.hz + WALK_BODY_RADIUS_M - Math.abs(localZ);
        if (penetrationX <= penetrationZ) {
            localX += (localX >= 0 ? 1 : -1) * penetrationX;
        } else {
            localZ += (localZ >= 0 ? 1 : -1) * penetrationZ;
        }
    }
    return {
        x: collider.cx + localX * collider.cos + localZ * collider.sin,
        z: collider.cz - localX * collider.sin + localZ * collider.cos,
    };
}

function nearbyColliders(x, z) {
    if (!colliderGrid) return [];
    const bucket = colliderGrid.get(cellKey(x, z));
    return bucket || [];
}

function distanceSqToColliderFootprint(collider, x, z) {
    const dx = x - collider.cx;
    const dz = z - collider.cz;
    const localX = dx * collider.cos - dz * collider.sin;
    const localZ = dx * collider.sin + dz * collider.cos;
    const outsideX = Math.max(0, Math.abs(localX) - collider.hx);
    const outsideZ = Math.max(0, Math.abs(localZ) - collider.hz);
    return outsideX * outsideX + outsideZ * outsideZ;
}

function colliderStableKey(collider) {
    return [
        collider.cx, collider.cz, collider.hx, collider.hz,
        collider.minY, collider.maxY, collider.sin, collider.cos,
    ].map(value => Math.round(value * 100)).join(':');
}

// GTA reuses the civil geometry already selected for walk collision instead of
// deriving a second set from OSM tags. The broadphase returns only nearby
// upright boxes (tunnel/cut walls, fences, supports, station shells, etc.) and
// gives each geometric box a deterministic session-local key so streamed
// rebuilds replace rather than duplicate Rapier colliders.
export function getWalkColliderBoxesNear(x, z, radiusM = 150, maxColliders = 320, { excludeGroundSurfaces = false } = {}) {
    ensureColliders();
    if (!colliderGrid) return [];
    const centerX = Number(x);
    const centerZ = Number(z);
    const radius = Math.max(0, Number(radiusM) || 0);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerZ) || radius <= 0) return [];
    const minCellX = Math.floor((centerX - radius) / GRID_CELL_M);
    const maxCellX = Math.floor((centerX + radius) / GRID_CELL_M);
    const minCellZ = Math.floor((centerZ - radius) / GRID_CELL_M);
    const maxCellZ = Math.floor((centerZ + radius) / GRID_CELL_M);
    const radiusSq = radius * radius;
    const visited = new Set();
    const byKey = new Map();
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
            for (const collider of colliderGrid.get(`${cellX}|${cellZ}`) || []) {
                if (excludeGroundSurfaces && collider.groundColliderState?.published) continue;
                if (visited.has(collider)) continue;
                visited.add(collider);
                const distanceSq = distanceSqToColliderFootprint(collider, centerX, centerZ);
                if (distanceSq > radiusSq) continue;
                const key = colliderStableKey(collider);
                if (!byKey.has(key)) byKey.set(key, { ...collider, key, distanceSq });
            }
        }
    }
    return [...byKey.values()]
        .sort((a, b) => a.distanceSq - b.distanceSq || a.key.localeCompare(b.key))
        .slice(0, Math.max(0, Math.trunc(Number(maxColliders) || 0)));
}

function resolveAt(x, z, feetY) {
    let outX = x;
    let outZ = z;
    for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const collider of nearbyColliders(outX, outZ)) {
            const dx = outX - collider.cx;
            const dz = outZ - collider.cz;
            if (dx * dx + dz * dz > collider.reach * collider.reach) continue;
            if (!blocksWalker(collider, feetY)) continue;
            const resolved = depenetrate(collider, outX, outZ);
            if (!resolved) continue;
            outX = resolved.x;
            outZ = resolved.z;
            moved = true;
        }
        if (!moved) break;
    }
    return { x: outX, z: outZ };
}

// Walks the move in short substeps so a brisk stride cannot tunnel through a
// thin wall, depenetrating at each one.
export function resolveWalkMove(fromX, fromZ, toX, toZ, feetY) {
    if (!ensureColliders().length) return { x: toX, z: toZ };
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return { x: toX, z: toZ };
    const substeps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP_M));
    const stepX = dx / substeps;
    const stepZ = dz / substeps;
    let x = fromX;
    let z = fromZ;
    for (let i = 0; i < substeps; i++) {
        // Each substep starts from where the previous one *ended*, so a wall hit
        // half way through the stride still stops the rest of it.
        const resolved = resolveAt(x + stepX, z + stepZ, feetY);
        x = resolved.x;
        z = resolved.z;
    }
    return { x, z };
}

export function resolveWalkCameraLineOfSight(target, desired) {
    const radius = Math.hypot(desired.x - target.x, desired.z - target.z) * .5 + .3;
    const boxes = getWalkColliderBoxesNear(
        (target.x + desired.x) * .5, (target.z + desired.z) * .5, radius, 128,
    );
    return resolveWalkCameraPose(target, desired, boxes);
}
