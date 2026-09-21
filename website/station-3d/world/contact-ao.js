// Contact-AO skirts: fake ambient occlusion where building walls meet the
// ground — one vertical gradient strip up the wall base plus one horizontal
// gradient strip outward on the ground, both fading from AO_ALPHA at the seam
// to zero. The classic cheap "grounding" trick (blob/contact shadow): a few
// triangles per wall face, no per-frame cost, no post-processing — safe on
// mobile. buildings.js feeds it ground-touching exterior wall faces.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';

const AO_WALL_H = 1.1;      // gradient height up the wall (m)
const AO_GROUND_W = 0.9;    // gradient reach outward on the ground (m)
const AO_ALPHA = 0.32;      // peak darkening at the wall/ground seam
const AO_FORWARD = 0.02;    // wall strip sits this far off the wall plane
const AO_LIFT = 0.06;       // ground strip sits this far above ground level

let _aoMat = null;

function getAoMat() {
    if (_aoMat) return _aoMat;
    _aoMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,          // multiplied by black RGBA vertex colours
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
    registerShared(_aoMat);
    return _aoMat;
}

// Appends the two skirt quads for one wall face into aoPos/aoCol.
// Face frame: origin = bottom start corner of the wall run, u = unit tangent
// along the wall, n = unit OUTWARD horizontal normal, width = run length,
// vMin = ground level of the face. Corner overlaps between adjacent faces
// darken twice — which is what real AO does in corners.
export function pushContactAoSkirt(aoPos, aoCol, { originX, originZ, ux, uz, nx, nz, width, vMin }) {
    // World position from face-local (u along wall, v = world Y, w outward).
    const quad = (a, b, c, d, alphas) => {
        // Two triangles: a-b-c, a-c-d. Vertices are [u, v, w] triples.
        for (const [vtx, alpha] of [
            [a, alphas[0]], [b, alphas[1]], [c, alphas[2]],
            [a, alphas[0]], [c, alphas[2]], [d, alphas[3]],
        ]) {
            aoPos.push(
                originX + vtx[0] * ux + vtx[2] * nx,
                vtx[1],
                originZ + vtx[0] * uz + vtx[2] * nz,
            );
            aoCol.push(0, 0, 0, alpha);
        }
    };
    // Wall strip: seam at the bottom, fades going up.
    quad(
        [0, vMin, AO_FORWARD], [width, vMin, AO_FORWARD],
        [width, vMin + AO_WALL_H, AO_FORWARD], [0, vMin + AO_WALL_H, AO_FORWARD],
        [AO_ALPHA, AO_ALPHA, 0, 0],
    );
    // Ground strip: seam at the wall line, fades going outward.
    quad(
        [0, vMin + AO_LIFT, 0], [width, vMin + AO_LIFT, 0],
        [width, vMin + AO_LIFT, AO_GROUND_W], [0, vMin + AO_LIFT, AO_GROUND_W],
        [AO_ALPHA, AO_ALPHA, 0, 0],
    );
}

// Unlit gradient quads — no normals needed, RGBA vertex colours (itemSize 4
// enables per-vertex alpha), rendered after opaque geometry without writing
// depth. Returns null when there is nothing to build; caller adds to the
// group and tags tileKey/objectId for eviction.
export function buildContactAoMesh(aoPos, aoCol) {
    if (aoPos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    const positions = aoPos instanceof Float32Array ? aoPos : Float32Array.from(aoPos);
    const colors = aoCol instanceof Float32Array ? aoCol : Float32Array.from(aoCol);
    // BufferAttribute retains already-typed storage. Float32BufferAttribute
    // wraps it in another Float32Array and copies the whole tile at publish.
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const mesh = new THREE.Mesh(geo, getAoMat());
    mesh.name = 'BuildingContactAO';
    mesh.userData.contactAo = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 5;
    return mesh;
}
