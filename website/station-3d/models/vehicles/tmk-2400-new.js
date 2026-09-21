// New standalone TMK 2400 model study, kept as a reusable factory so it can be
// selected or refined independently from the legacy production model.

import * as THREE from 'three';
import { registerShared } from '../../core/dispose.js';

export const TMK_2400_LENGTH_M = 20.8;
export const TMK_2400_WIDTH_M = 2.4;

let assets = null;
const bodyMaterials = new Map();

function buildStreamlinedCabGeometry() {
    const bodyHeight = 3.03;
    const length = 2.35;
    const ringCount = 10;
    const ringSegments = 18;
    const positions = [];
    const indices = [];
    for (let ring = 0; ring < ringCount; ring++) {
        const t = ring / (ringCount - 1);
        const eased = t * t * (3 - 2 * t);
        const halfWidth = THREE.MathUtils.lerp(TMK_2400_WIDTH_M / 2, 0.74, eased);
        const bottom = THREE.MathUtils.lerp(0, 0.25, eased);
        const top = THREE.MathUtils.lerp(bodyHeight, 2.48, eased);
        const halfHeight = (top - bottom) / 2;
        const centerY = (top + bottom) / 2;
        for (let step = 0; step < ringSegments; step++) {
            const angle = step / ringSegments * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const x = halfWidth * Math.sign(cos) * Math.abs(cos) ** 0.42;
            const y = centerY + halfHeight * Math.sign(sin) * Math.abs(sin) ** 0.42;
            const yNorm = THREE.MathUtils.clamp((y - bottom) / Math.max(0.01, top - bottom), 0, 1);
            const upperTurn = THREE.MathUtils.clamp((yNorm - 0.52) / 0.48, 0, 1) ** 1.7;
            const sideRound = 1 - 0.12 * (x / halfWidth) ** 2;
            positions.push(
                x,
                y,
                length * (1 - Math.cos(t * Math.PI / 2)) * (1 - 0.38 * upperTurn) * sideRound,
            );
        }
    }
    for (let ring = 0; ring + 1 < ringCount; ring++) {
        for (let step = 0; step < ringSegments; step++) {
            const next = (step + 1) % ringSegments;
            const a = ring * ringSegments + step;
            const b = ring * ringSegments + next;
            const c = (ring + 1) * ringSegments + next;
            const d = (ring + 1) * ringSegments + step;
            indices.push(a, b, c, a, c, d);
        }
    }
    const tipCenter = positions.length / 3;
    positions.push(0, THREE.MathUtils.lerp(0.25, 2.48, 0.42), 2.35);
    const lastRing = (ringCount - 1) * ringSegments;
    for (let step = 0; step < ringSegments; step++) {
        indices.push(lastRing + step, lastRing + (step + 1) % ringSegments, tipCenter);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function buildCabWindowGeometry() {
    const columns = 12;
    const rows = 6;
    const positions = [];
    const indices = [];
    for (let row = 0; row <= rows; row++) {
        const yNorm = THREE.MathUtils.lerp(0.54, 0.84, row / rows);
        const y = THREE.MathUtils.lerp(0.25, 2.48, yNorm);
        const upperTurn = THREE.MathUtils.clamp((yNorm - 0.52) / 0.48, 0, 1) ** 1.7;
        for (let column = 0; column <= columns; column++) {
            const xNorm = THREE.MathUtils.lerp(-0.82, 0.82, column / columns);
            const sideRound = 1 - 0.12 * xNorm * xNorm;
            positions.push(
                xNorm * 0.74,
                y,
                2.35 * (1 - 0.38 * upperTurn) * sideRound + 0.018,
            );
        }
    }
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const a = row * (columns + 1) + column;
            const b = a + 1;
            const c = a + columns + 2;
            const d = a + columns + 1;
            indices.push(a, b, c, a, c, d);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function ensureAssets() {
    if (assets) return assets;
    const geometry = {
        body: new THREE.BoxGeometry(TMK_2400_WIDTH_M, 2.75, TMK_2400_LENGTH_M - 4.7),
        skirt: new THREE.BoxGeometry(TMK_2400_WIDTH_M * 0.94, 0.42, TMK_2400_LENGTH_M - 4.7),
        roof: new THREE.BoxGeometry(TMK_2400_WIDTH_M * 0.96, 0.28, TMK_2400_LENGTH_M - 4.7),
        cab: buildStreamlinedCabGeometry(),
        windscreen: buildCabWindowGeometry(),
        window: new THREE.BoxGeometry(0.035, 0.88, 1.22),
        bellows: new THREE.BoxGeometry(TMK_2400_WIDTH_M + 0.06, 2.62, 0.18),
        door: new THREE.BoxGeometry(0.06, 2.18, 1.38),
        doorWindow: new THREE.BoxGeometry(0.025, 0.76, 1.08),
        bogie: new THREE.BoxGeometry(1.48, 0.34, 2.25),
        wheel: new THREE.CylinderGeometry(0.36, 0.36, 0.12, 16),
        pantoArm: new THREE.BoxGeometry(0.07, 1.8, 0.07),
        pantoStrip: new THREE.BoxGeometry(1.9, 0.06, 0.18),
    };
    geometry.wheel.rotateZ(Math.PI / 2);
    const material = {
        glass: new THREE.MeshStandardMaterial({ color: 0x182938, roughness: 0.12, metalness: 0.42 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x242a31, roughness: 0.74, metalness: 0.22 }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.9 }),
    };
    registerShared(...Object.values(geometry), ...Object.values(material));
    assets = { geometry, material };
    return assets;
}

function bodyMaterial(cssColor) {
    const color = new THREE.Color(cssColor || '#1688cc').getHex();
    if (!bodyMaterials.has(color)) {
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.08 });
        registerShared(material);
        bodyMaterials.set(color, material);
    }
    return bodyMaterials.get(color);
}

function addMesh(parent, geometry, material, x, y, z) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
}

export function createTmk2400Mesh({ color = '#1688cc' } = {}) {
    const { geometry: g, material: m } = ensureAssets();
    const body = bodyMaterial(color);
    const root = new THREE.Group();
    const centerLength = TMK_2400_LENGTH_M - 4.7;
    addMesh(root, g.body, body, 0, 2.0, 0);
    addMesh(root, g.skirt, m.dark, 0, 0.56, 0);
    addMesh(root, g.roof, m.dark, 0, 3.52, 0);

    for (const end of [-1, 1]) {
        const cab = addMesh(root, g.cab, body, 0, 0.62, end * centerLength / 2);
        cab.rotation.y = end < 0 ? Math.PI : 0;
        const windshield = addMesh(root, g.windscreen, m.glass, 0, 0.62, end * centerLength / 2);
        windshield.rotation.y = end < 0 ? Math.PI : 0;
    }
    for (const side of [-1, 1]) {
        for (let z = -TMK_2400_LENGTH_M / 2 + 1.35; z <= TMK_2400_LENGTH_M / 2 - 1.35; z += 1.7) {
            addMesh(root, g.window, m.glass, side * (TMK_2400_WIDTH_M / 2 + 0.02), 2.35, z);
        }
    }
    for (const z of [-TMK_2400_LENGTH_M * 0.165, TMK_2400_LENGTH_M * 0.165]) {
        addMesh(root, g.bellows, m.rubber, 0, 1.96, z);
    }
    for (const z of [-7.1, -2.4, 2.4, 7.1]) {
        const door = addMesh(root, g.door, m.dark, TMK_2400_WIDTH_M / 2 + 0.045, 1.68, z);
        addMesh(root, g.doorWindow, m.glass, door.position.x + 0.04, 2.2, z);
    }
    for (const bogieZ of [-7.3, 7.3]) {
        addMesh(root, g.bogie, m.dark, 0, 0.42, bogieZ);
        for (const side of [-1, 1]) {
            for (const wheelZ of [-0.72, 0.72]) {
                addMesh(root, g.wheel, m.rubber, side * 0.5, 0.42, bogieZ + wheelZ);
            }
        }
    }
    const panto = new THREE.Group();
    for (const side of [-1, 1]) {
        const arm = addMesh(panto, g.pantoArm, m.dark, side * 0.38, 0.88, 0);
        arm.rotation.z = -side * 0.45;
    }
    addMesh(panto, g.pantoStrip, m.dark, 0, 1.75, 0);
    panto.position.set(0, 3.66, -3.8);
    root.add(panto);
    root.userData.vehicleModel = 'tmk-2400';
    root.userData.labelAnchor = new THREE.Vector3(0, 6.2, 0);
    return root;
}
