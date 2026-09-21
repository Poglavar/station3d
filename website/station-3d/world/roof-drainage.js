// Zinc rain gutters along the eaves, and one downpipe per building.
//
// GDI roofs sit flush on the walls — there is no overhang to hang a gutter
// under — so the trough is bracket-mounted against the wall head, which is what
// a flush eave actually carries. buildings.js feeds it the logical facade
// surfaces it already computed for the window overlay, so the eaves line costs
// no new geometry pass, and the whole tile's drainage merges into ONE mesh (the
// same trick contact-ao.js uses): a gutter per building would be ~500 extra
// draw calls, a gutter per tile is one.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';

// Large buildings first. A gutter on every garden shed is a lot of geometry for
// something nobody stands close enough to see; raise or lower this to taste.
export const GUTTER_MIN_FOOTPRINT_M2 = 300;
// A wall carries an eave only if its head is horizontal across most of its
// width. A gable end takes a verge, not a gutter, and putting one there reads
// as a mistake — so the gable's sloped head disqualifies it here.
const EAVES_HEAD_TOLERANCE_M = 0.3;
const EAVES_MIN_WIDTH_FRACTION = 0.8;
const EAVES_MIN_RUN_M = 3.5;

const GUTTER_OUT_M = 0.13;      // how far the trough stands off the wall face
const GUTTER_DEPTH_M = 0.11;    // trough depth
const GUTTER_DROP_M = 0.06;     // trough top sits this far below the wall head
const GUTTER_BACK_M = 0.012;    // back plate clears the wall plane
const PIPE_SIDE_M = 0.09;       // square section — the common Zagreb downpipe
const PIPE_GAP_M = 0.035;       // stand-off from the wall face
const PIPE_INSET_M = 0.35;      // in from the corner, so it lands on the wall
const PIPE_FOOT_Y = 0.14;       // the shoe stops just above the pavement

let _material = null;

export function getRoofDrainageMaterial() {
    if (_material) return _material;
    _material = new THREE.MeshStandardMaterial({
        color: 0x9aa2a8,          // weathered zinc
        metalness: 0.55,
        roughness: 0.45,
        envMapIntensity: 1.0,
        side: THREE.DoubleSide,
    });
    registerShared(_material);
    return _material;
}

// Does this wall's head run level across it? The surface's projected triangles
// are already in (u = along the wall, v = height) coordinates.
export function surfaceCarriesEaves(surface) {
    if (!surface) return false;
    const width = surface.maxU - surface.minU;
    if (!(width >= EAVES_MIN_RUN_M)) return false;
    let headMinU = Infinity;
    let headMaxU = -Infinity;
    for (const triangle of surface.triangles || []) {
        for (const point of triangle) {
            if (surface.maxV - point.v > EAVES_HEAD_TOLERANCE_M) continue;
            if (point.u < headMinU) headMinU = point.u;
            if (point.u > headMaxU) headMaxU = point.u;
        }
    }
    if (!(headMaxU > headMinU)) return false;
    return (headMaxU - headMinU) >= width * EAVES_MIN_WIDTH_FRACTION;
}

function pushQuad(out, a, b, c, d) {
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

// A U-section trough hung on the wall head: back plate, floor, front lip, and a
// cap at each end so the open section is never seen from below.
export function pushEavesGutter(out, { originX, originZ, ux, uz, nx, nz, width, headY }) {
    const topY = headY - GUTTER_DROP_M;
    const floorY = topY - GUTTER_DEPTH_M;
    const at = (u, offset, y) => [
        originX + ux * u + nx * offset,
        y,
        originZ + uz * u + nz * offset,
    ];
    const back = GUTTER_BACK_M;
    const front = GUTTER_OUT_M;

    // Back plate against the wall.
    pushQuad(out, at(0, back, floorY), at(width, back, floorY), at(width, back, topY), at(0, back, topY));
    // Floor of the trough.
    pushQuad(out, at(0, back, floorY), at(0, front, floorY), at(width, front, floorY), at(width, back, floorY));
    // Front lip.
    pushQuad(out, at(0, front, floorY), at(0, front, topY), at(width, front, topY), at(width, front, floorY));
    // End caps.
    pushQuad(out, at(0, back, floorY), at(0, back, topY), at(0, front, topY), at(0, front, floorY));
    pushQuad(out, at(width, back, floorY), at(width, front, floorY), at(width, front, topY), at(width, back, topY));
}

// One square downpipe, from the gutter floor to a shoe above the pavement.
export function pushDownpipe(out, { originX, originZ, ux, uz, nx, nz, u, headY, baseY }) {
    const topY = headY - GUTTER_DROP_M - GUTTER_DEPTH_M + 0.02;
    const bottomY = Math.min(topY - 0.5, baseY + PIPE_FOOT_Y);
    if (!(topY > bottomY)) return;
    const half = PIPE_SIDE_M / 2;
    const centerOffset = PIPE_GAP_M + half;
    const at = (du, offset, y) => [
        originX + ux * (u + du) + nx * offset,
        y,
        originZ + uz * (u + du) + nz * offset,
    ];
    const corners = [
        [-half, centerOffset - half],
        [half, centerOffset - half],
        [half, centerOffset + half],
        [-half, centerOffset + half],
    ];
    for (let i = 0; i < 4; i++) {
        const [du0, o0] = corners[i];
        const [du1, o1] = corners[(i + 1) % 4];
        pushQuad(
            out,
            at(du0, o0, bottomY),
            at(du1, o1, bottomY),
            at(du1, o1, topY),
            at(du0, o0, topY),
        );
    }
}

// Where along this eaves run should the pipe go? A corner, picked from the
// building's own hash so it never moves when its tile is rebuilt.
export function pickDownpipeU(width, hash) {
    const atStart = (hash & 1) === 0;
    const inset = Math.min(PIPE_INSET_M, width * 0.25);
    return atStart ? inset : width - inset;
}

export function buildRoofDrainageMesh(positions) {
    if (!positions || positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, getRoofDrainageMaterial());
    mesh.name = 'RoofDrainage';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
}
