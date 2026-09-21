// Square cast-iron cover appearance and local part geometry, shared by pavement dressing.
import * as THREE from 'three';
import { registerShared } from '../../core/dispose.js';

const MANHOLE_SIZE_M = 0.62;
const MANHOLE_BASE_Y = 0.0;
const MANHOLE_TOP_Y = 0.062;

function makeCoverTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // The outer band is what the lid's short sides sample — keep it dark iron.
    ctx.fillStyle = '#33373a';
    ctx.fillRect(0, 0, size, size);
    const rim = size * 0.08;
    ctx.fillStyle = '#3f4448';
    ctx.fillRect(rim, rim, size - rim * 2, size - rim * 2);

    // Raised waffle tread, the usual cast pattern.
    const inner = rim * 2;
    const cells = 6;
    const cell = (size - inner * 2) / cells;
    for (let row = 0; row < cells; row++) {
        for (let col = 0; col < cells; col++) {
            const x = inner + col * cell;
            const y = inner + row * cell;
            ctx.fillStyle = 'rgba(122,128,133,0.55)';
            ctx.fillRect(x + 1, y + 1, cell - 3, cell - 3);
            ctx.fillStyle = 'rgba(24,27,29,0.55)';
            ctx.fillRect(x + cell - 3, y + 1, 2, cell - 3);
            ctx.fillRect(x + 1, y + cell - 3, cell - 3, 2);
        }
    }
    // Weathering: road grime settles in the tread, and the lid rusts unevenly.
    for (let i = 0; i < 40; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        ctx.fillStyle = `rgba(${60 + Math.random() * 40},${52 + Math.random() * 30},${44 + Math.random() * 24},0.12)`;
        ctx.beginPath();
        ctx.arc(x, y, 2 + Math.random() * 9, 0, Math.PI * 2);
        ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    registerShared(texture);
    return texture;
}

export function createManholeMaterial() {
    return new THREE.MeshStandardMaterial({ map: makeCoverTexture(), roughness: 0.72, metalness: 0.35 });
}

export function pushCover(positions, uvs, { x, z, ux, uz, nx, nz }) {
    const half = MANHOLE_SIZE_M / 2;
    // Corner order: back-left, back-right, front-right, front-left, seen from
    // above with +u to the right and +n away from the road.
    const corner = (su, sn) => [
        x + ux * (half * su) + nx * (half * sn),
        z + uz * (half * su) + nz * (half * sn),
    ];
    const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const top = MANHOLE_TOP_Y;
    const base = MANHOLE_BASE_Y;

    // Lid: the whole texture, so the tread pattern reads at any rotation.
    const lidUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const quad = (a, b, cc, d, uvA, uvB, uvC, uvD) => {
        positions.push(...a, ...b, ...cc, ...a, ...cc, ...d);
        uvs.push(...uvA, ...uvB, ...uvC, ...uvA, ...uvC, ...uvD);
    };
    quad(
        [c[0][0], top, c[0][1]], [c[1][0], top, c[1][1]],
        [c[2][0], top, c[2][1]], [c[3][0], top, c[3][1]],
        lidUv[0], lidUv[1], lidUv[2], lidUv[3],
    );
    // Frame sides sample the dark outer band of the same texture.
    const sideUv = [[0, 0], [0.06, 0], [0.06, 0.06], [0, 0.06]];
    for (let i = 0; i < 4; i++) {
        const a = c[i];
        const b = c[(i + 1) % 4];
        quad(
            [a[0], base, a[1]], [b[0], base, b[1]],
            [b[0], top, b[1]], [a[0], top, a[1]],
            sideUv[0], sideUv[1], sideUv[2], sideUv[3],
        );
    }
}

export function createManholeMesh(out, material) {
    if (!out || out.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(out.uvs, 2));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'Manholes';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
}
