// Reusable HŽ 7022 three-car diesel-electric train model shared by cab,
// walk-mode ambient traffic, and the standalone rolling-stock inspector.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared } from '../../core/dispose.js';

export const HZ_7022_CAR_COUNT = 3;
export const HZ_7022_CAR_LENGTH_M = 22.98;
export const HZ_7022_CAR_SPACING_M = 23.735;
export const HZ_7022_TOTAL_LENGTH_M =
    (HZ_7022_CAR_COUNT - 1) * HZ_7022_CAR_SPACING_M + HZ_7022_CAR_LENGTH_M;
export const HZ_7022_HALF_LENGTH_M = HZ_7022_TOTAL_LENGTH_M * 0.5;
export const HZ_7022_HALF_WIDTH_M = 2.885 * 0.5;

const BODY_WIDTH_M = 2.885;
const BODY_HEIGHT_M = 2.75;
const BODY_CENTER_ABOVE_RAIL_M = 1.95;
const NOSE_LENGTH_M = 1.68;
const NOSE_FRONT_WIDTH_M = 2.04;
const NOSE_FRONT_BOTTOM_M = 0.26;
const NOSE_FRONT_TOP_M = 2.68;
const NOSE_BODY_HEIGHT_M = 3.2;

let assets = null;
const batchedCarTemplates = new Map();

function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function createSurfaceTexture({ roof = false } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const rand = createSeededRandom(roof ? 0x1f2937 : 0x5a67d8);
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (roof) {
        gradient.addColorStop(0, '#d8dde2');
        gradient.addColorStop(1, '#adb6bf');
    } else {
        gradient.addColorStop(0, '#f1f4f6');
        gradient.addColorStop(0.5, '#e6ebef');
        gradient.addColorStop(1, '#cfd6dc');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < 180; index++) {
        const grey = roof ? 78 : 120;
        ctx.fillStyle = `rgba(${grey},${grey + 8},${grey + 16},${0.02 + rand() * 0.05})`;
        ctx.fillRect(
            rand() * canvas.width,
            rand() * canvas.height,
            1 + rand() * (roof ? 10 : 2),
            1 + rand() * (roof ? 2 : 28),
        );
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.repeat.set(1, 1);
    registerShared(texture);
    return texture;
}

function buildNoseGeometry() {
    const ringCount = 9;
    const ringSegments = 16;
    const positions = [];
    const indices = [];
    for (let ring = 0; ring < ringCount; ring++) {
        const t = ring / (ringCount - 1);
        const eased = t * t * (3 - 2 * t);
        const halfWidth = THREE.MathUtils.lerp(BODY_WIDTH_M / 2, NOSE_FRONT_WIDTH_M / 2, eased);
        const bottom = THREE.MathUtils.lerp(0, NOSE_FRONT_BOTTOM_M, eased);
        const top = THREE.MathUtils.lerp(NOSE_BODY_HEIGHT_M, NOSE_FRONT_TOP_M, eased);
        const halfHeight = (top - bottom) * 0.5;
        const centerY = (top + bottom) * 0.5;
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
                NOSE_LENGTH_M * (1 - Math.cos(t * Math.PI / 2)) * (1 - 0.38 * upperTurn) * sideRound,
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
    positions.push(
        0,
        THREE.MathUtils.lerp(NOSE_FRONT_BOTTOM_M, NOSE_FRONT_TOP_M, 0.42),
        NOSE_LENGTH_M,
    );
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

function buildWindscreenGeometry() {
    const columns = 12;
    const rows = 6;
    const positions = [];
    const indices = [];
    for (let row = 0; row <= rows; row++) {
        const yNorm = THREE.MathUtils.lerp(0.50, 0.82, row / rows);
        const y = THREE.MathUtils.lerp(NOSE_FRONT_BOTTOM_M, NOSE_FRONT_TOP_M, yNorm);
        const upperTurn = THREE.MathUtils.clamp((yNorm - 0.52) / 0.48, 0, 1) ** 1.7;
        for (let column = 0; column <= columns; column++) {
            const xNorm = THREE.MathUtils.lerp(-0.82, 0.82, column / columns);
            const sideRound = 1 - 0.12 * xNorm * xNorm;
            positions.push(
                xNorm * NOSE_FRONT_WIDTH_M / 2,
                y,
                NOSE_LENGTH_M * (1 - 0.38 * upperTurn) * sideRound + 0.018,
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

function buildCabSideWindowGeometry() {
    const columns = 7;
    const rows = 4;
    const positions = [];
    const indices = [];
    for (const side of [-1, 1]) {
        const vertexBase = positions.length / 3;
        for (let row = 0; row <= rows; row++) {
            const yNorm = THREE.MathUtils.lerp(0.53, 0.79, row / rows);
            const signedY = yNorm * 2 - 1;
            const sin = Math.sign(signedY) * Math.abs(signedY) ** (1 / 0.42);
            const cos = Math.sqrt(Math.max(0, 1 - sin * sin));
            const upperTurn = THREE.MathUtils.clamp((yNorm - 0.52) / 0.48, 0, 1) ** 1.7;
            for (let column = 0; column <= columns; column++) {
                const t = THREE.MathUtils.lerp(0.08, 0.74, column / columns);
                const eased = t * t * (3 - 2 * t);
                const halfWidth = THREE.MathUtils.lerp(
                    BODY_WIDTH_M / 2,
                    NOSE_FRONT_WIDTH_M / 2,
                    eased,
                );
                const bottom = THREE.MathUtils.lerp(0, NOSE_FRONT_BOTTOM_M, eased);
                const top = THREE.MathUtils.lerp(NOSE_BODY_HEIGHT_M, NOSE_FRONT_TOP_M, eased);
                const x = side * halfWidth * cos ** 0.42;
                const y = THREE.MathUtils.lerp(bottom, top, yNorm);
                const sideRound = 1 - 0.12 * (x / halfWidth) ** 2;
                const z = NOSE_LENGTH_M
                    * (1 - Math.cos(t * Math.PI / 2))
                    * (1 - 0.38 * upperTurn)
                    * sideRound;
                // Offset along the side normal just enough to avoid z-fighting;
                // the glazing itself retains the nose's compound curvature.
                positions.push(x + side * 0.018, y, z);
            }
        }
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const a = vertexBase + row * (columns + 1) + column;
                const b = a + 1;
                const c = a + columns + 2;
                const d = a + columns + 1;
                if (side < 0) indices.push(a, c, b, a, d, c);
                else indices.push(a, b, c, a, c, d);
            }
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
        body: new THREE.BoxGeometry(BODY_WIDTH_M, BODY_HEIGHT_M, HZ_7022_CAR_LENGTH_M),
        skirt: new THREE.BoxGeometry(2.73, 0.42, HZ_7022_CAR_LENGTH_M - 1),
        roofBase: new THREE.BoxGeometry(2.82, 0.26, HZ_7022_CAR_LENGTH_M - 0.4),
        roofCrown: new THREE.BoxGeometry(2.38, 0.20, HZ_7022_CAR_LENGTH_M - 1.2),
        roofPod: new THREE.BoxGeometry(1.82, 0.42, 3.2),
        stripe: new THREE.BoxGeometry(0.04, 0.30, HZ_7022_CAR_LENGTH_M - 0.2),
        windowBand: new THREE.BoxGeometry(0.05, 1.02, 16.4),
        mullion: new THREE.BoxGeometry(0.075, 1.02, 0.16),
        doorRecess: new THREE.BoxGeometry(0.05, 2.12, 1.40),
        doorLeaf: new THREE.BoxGeometry(0.055, 2.04, 0.64),
        nose: buildNoseGeometry(),
        windscreen: buildWindscreenGeometry(),
        cabSideWindow: buildCabSideWindowGeometry(),
        headlight: new THREE.BoxGeometry(0.30, 0.17, 0.10),
        tailLight: new THREE.BoxGeometry(0.16, 0.12, 0.09),
        bogie: new THREE.BoxGeometry(2.1, 0.50, 2.9),
        wheel: new THREE.CylinderGeometry(0.42, 0.42, 0.10, 12),
        gangway: new THREE.BoxGeometry(2.15, 2.45, 0.95),
    };
    geometry.wheel.rotateZ(Math.PI / 2);
    const material = {
        body: new THREE.MeshStandardMaterial({
            color: 0xf2f5f7,
            map: createSurfaceTexture(),
            roughness: 0.72,
            metalness: 0.05,
        }),
        roof: new THREE.MeshStandardMaterial({
            color: 0xe0e5ea,
            map: createSurfaceTexture({ roof: true }),
            roughness: 0.86,
            metalness: 0.04,
        }),
        skirt: new THREE.MeshStandardMaterial({ color: 0x2d3440, roughness: 0.82, metalness: 0.10 }),
        stripe: new THREE.MeshStandardMaterial({ color: 0xc4152d, roughness: 0.42, metalness: 0.12 }),
        yellow: new THREE.MeshStandardMaterial({ color: 0xf2c318, roughness: 0.62, metalness: 0.03 }),
        glass: new THREE.MeshStandardMaterial({
            color: 0x0e141b,
            roughness: 0.10,
            metalness: 0.30,
            envMapIntensity: 1.25,
            side: THREE.DoubleSide,
        }),
        door: new THREE.MeshStandardMaterial({ color: 0xe2e7ea, roughness: 0.62, metalness: 0.06 }),
        wheel: new THREE.MeshStandardMaterial({ color: 0x171a1f, roughness: 0.5, metalness: 0.45 }),
        headlight: new THREE.MeshStandardMaterial({
            color: 0xfff6c8,
            emissive: 0xfff0b0,
            emissiveIntensity: 1.4,
            roughness: 0.35,
        }),
        tailLight: new THREE.MeshStandardMaterial({
            color: 0x7a1220,
            emissive: 0xe11d2e,
            emissiveIntensity: 1.1,
            roughness: 0.35,
        }),
    };
    registerShared(...Object.values(geometry), ...Object.values(material));
    assets = { geometry, material };
    return assets;
}

function addMesh(parent, geometry, material, x, y, z) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
}

function createDetailedCar(index, railY) {
    const { geometry: g, material: m } = ensureAssets();
    const car = new THREE.Group();
    car.userData.doorParts = [];
    const bodyY = railY + BODY_CENTER_ABOVE_RAIL_M;
    const bodyTopY = bodyY + BODY_HEIGHT_M / 2;
    const bodyBottomY = bodyY - BODY_HEIGHT_M / 2;

    addMesh(car, g.body, m.body, 0, bodyY, 0);
    addMesh(car, g.skirt, m.skirt, 0, railY + 0.55, 0);
    addMesh(car, g.roofBase, m.roof, 0, bodyTopY + 0.13, 0);
    addMesh(car, g.roofCrown, m.roof, 0, bodyTopY + 0.36, 0);

    for (const side of [-1, 1]) {
        addMesh(car, g.stripe, m.stripe, side * (BODY_WIDTH_M / 2 + 0.005), bodyY - 0.28, 0);
        addMesh(car, g.windowBand, m.glass, side * (BODY_WIDTH_M / 2 + 0.01), bodyY + 0.62, 0);
        for (let z = -6.4; z <= 6.4; z += 3.2) {
            addMesh(car, g.mullion, m.body, side * (BODY_WIDTH_M / 2 + 0.02), bodyY + 0.62, z);
        }
        for (const doorZ of [-9.35, 9.35]) {
            const doorY = bodyBottomY + 1.10;
            addMesh(car, g.doorRecess, m.glass, side * (BODY_WIDTH_M / 2 + 0.005), doorY, doorZ);
            for (const leafZ of [-0.34, 0.34]) {
                const leaf = addMesh(
                    car,
                    g.doorLeaf,
                    m.door,
                    side * (BODY_WIDTH_M / 2 + 0.03),
                    doorY,
                    doorZ + leafZ,
                );
                car.userData.doorParts.push({
                    mesh: leaf,
                    closedZ: leaf.position.z,
                    direction: leafZ < 0 ? -1 : 1,
                });
            }
        }
    }

    for (const podZ of [-5.8, 0, 5.8]) {
        const pod = addMesh(car, g.roofPod, m.skirt, 0, bodyTopY + 0.62, podZ);
        pod.scale.set(0.92, 0.82, 0.72);
    }
    for (const bogieZ of [-6.2, 6.2]) {
        addMesh(car, g.bogie, m.skirt, 0, railY + 0.42, bogieZ);
        for (const wheelX of [-1.02, 1.02]) {
            for (const wheelZ of [-0.95, 0.95]) {
                addMesh(car, g.wheel, m.wheel, wheelX, railY + 0.42, bogieZ + wheelZ);
            }
        }
    }

    if (index === 0 || index === HZ_7022_CAR_COUNT - 1) {
        const end = index === 0 ? -1 : 1;
        const nose = new THREE.Group();
        nose.rotation.y = end < 0 ? Math.PI : 0;
        nose.position.set(0, bodyBottomY, end * HZ_7022_CAR_LENGTH_M / 2);
        addMesh(nose, g.nose, m.body, 0, 0, 0);
        addMesh(nose, g.windscreen, m.glass, 0, 0, 0);
        addMesh(nose, g.cabSideWindow, m.glass, 0, 0, 0);
        const bumper = addMesh(
            nose,
            g.stripe,
            m.yellow,
            0,
            NOSE_FRONT_BOTTOM_M + 0.50,
            NOSE_LENGTH_M + 0.03,
        );
        bumper.scale.set(1, 0.8, NOSE_FRONT_WIDTH_M / (HZ_7022_CAR_LENGTH_M - 0.2));
        bumper.rotation.y = Math.PI / 2;
        for (const x of [-0.5, 0.5]) {
            addMesh(nose, g.headlight, m.headlight, x, NOSE_FRONT_BOTTOM_M + 0.30, NOSE_LENGTH_M + 0.04);
            addMesh(nose, g.tailLight, m.tailLight, x * 1.55, NOSE_FRONT_BOTTOM_M + 0.32, NOSE_LENGTH_M + 0.03);
        }
        car.add(nose);
    }

    if (index > 0) {
        addMesh(car, g.gangway, m.skirt, 0, bodyY - 0.1, -HZ_7022_CAR_LENGTH_M / 2 - 0.4);
    }
    if (index < HZ_7022_CAR_COUNT - 1) {
        addMesh(car, g.gangway, m.skirt, 0, bodyY - 0.1, HZ_7022_CAR_LENGTH_M / 2 + 0.4);
    }
    return car;
}

function ensureMergeCompatibleGeometry(sourceGeometry, transform) {
    const geometry = sourceGeometry.clone();
    geometry.applyMatrix4(transform);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
        geometry.setAttribute(
            'uv',
            new THREE.Float32BufferAttribute(
                new Float32Array(geometry.getAttribute('position').count * 2),
                2,
            ),
        );
    }
    return geometry;
}

function buildBatchedCarTemplate(index, railY) {
    const detailedCar = createDetailedCar(index, railY);
    detailedCar.updateMatrixWorld(true);
    const rootInverse = detailedCar.matrixWorld.clone().invert();
    const byMaterial = new Map();

    detailedCar.traverse((object) => {
        if (!object.isMesh || !object.geometry || !object.material) return;
        object.updateWorldMatrix(true, false);
        const transform = rootInverse.clone().multiply(object.matrixWorld);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.length !== 1) return;
        const material = materials[0];
        if (!byMaterial.has(material.uuid)) {
            byMaterial.set(material.uuid, { material, geometries: [] });
        }
        byMaterial.get(material.uuid).geometries.push(
            ensureMergeCompatibleGeometry(object.geometry, transform),
        );
    });

    const materialBatches = [];
    const materials = [];
    for (const { material, geometries } of byMaterial.values()) {
        const merged = mergeGeometries(geometries, false);
        for (const geometry of geometries) geometry.dispose();
        if (!merged) continue;
        materialBatches.push(merged);
        materials.push(material);
    }
    const geometry = mergeGeometries(materialBatches, true);
    for (const batch of materialBatches) batch.dispose();
    if (!geometry) {
        throw new Error(`Could not batch HŽ 7022 car ${index}`);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    registerShared(geometry);
    return { geometry, materials };
}

function getBatchedCarTemplate(index, railY) {
    const key = `${index}:${Number(railY).toFixed(3)}`;
    if (!batchedCarTemplates.has(key)) {
        batchedCarTemplates.set(key, buildBatchedCarTemplate(index, railY));
    }
    return batchedCarTemplates.get(key);
}

function createCar(index, railY, animatedDoors = false) {
    // Door leaves must remain separate transforms while an ambient service is
    // dwelling. Static/cab trains retain the aggressively batched mesh.
    if (animatedDoors) return createDetailedCar(index, railY);
    const template = getBatchedCarTemplate(index, railY);
    const car = new THREE.Group();
    const mesh = new THREE.Mesh(template.geometry, template.materials);
    mesh.name = `HZ7022CarBatch:${index}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    car.add(mesh);
    return car;
}

export function createHz7022Mesh({
    railY = 0,
    articulated = false,
    animatedDoors = false,
} = {}) {
    const root = new THREE.Group();
    const cars = [];
    for (let index = 0; index < HZ_7022_CAR_COUNT; index++) {
        const car = createCar(index, railY, animatedDoors);
        if (!articulated) car.position.z = (index - 1) * HZ_7022_CAR_SPACING_M;
        root.add(car);
        cars.push(car);
    }
    root.userData.cars = cars;
    root.userData.vehicleModel = 'hz-7022';
    root.userData.collisionHalfLengthM = HZ_7022_HALF_LENGTH_M;
    root.userData.collisionHalfWidthM = HZ_7022_HALF_WIDTH_M;
    root.userData.labelAnchor = new THREE.Vector3(0, railY + 7, 0);
    return root;
}

export function getHz7022AppearanceDebug() {
    const { material } = ensureAssets();
    return {
        bodyColor: material.body.color.getHex(),
        roofColor: material.roof.color.getHex(),
        bodyHasMap: !!material.body.map,
        roofHasMap: !!material.roof.map,
        bodyRoughness: material.body.roughness,
        roofRoughness: material.roof.roughness,
        batchedCarTemplateCount: batchedCarTemplates.size,
    };
}
