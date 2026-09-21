// Low-poly bicycle and cargo-bike meshes for bounded ambient road traffic.
// Each bicycle is one grouped BufferGeometry with three material batches.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { registerShared, unregisterShared } from '../../core/dispose.js';

const geometryByType = new Map();
const frameMaterials = new Map();
let tireMaterial = null;
let riderMaterial = null;

function materialForFrame(hex) {
    const key = Number(hex) >>> 0;
    let material = frameMaterials.get(key);
    if (!material) {
        material = new THREE.MeshStandardMaterial({ color: key, roughness: 0.62, metalness: 0.25 });
        registerShared(material);
        frameMaterials.set(key, material);
    }
    return material;
}

function getTireMaterial() {
    if (!tireMaterial) {
        tireMaterial = new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.94 });
        registerShared(tireMaterial);
    }
    return tireMaterial;
}

function getRiderMaterial() {
    if (!riderMaterial) {
        riderMaterial = new THREE.MeshStandardMaterial({ color: 0x245b8c, roughness: 0.82 });
        registerShared(riderMaterial);
    }
    return riderMaterial;
}

function transformedGeometry(geometry, position, scale, quaternion = null) {
    const copy = geometry.clone();
    geometry.dispose();
    const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, position.y, position.z),
        quaternion || new THREE.Quaternion(),
        new THREE.Vector3(scale.x, scale.y, scale.z),
    );
    copy.applyMatrix4(matrix);
    return copy;
}

function tubeBetween(from, to, radius = 0.035, radialSegments = 6) {
    const direction = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = direction.length();
    const midpoint = new THREE.Vector3(
        (from.x + to.x) * 0.5,
        (from.y + to.y) * 0.5,
        (from.z + to.z) * 0.5,
    );
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
    );
    return transformedGeometry(
        new THREE.CylinderGeometry(1, 1, 1, radialSegments),
        midpoint,
        { x: radius, y: length, z: radius },
        quaternion,
    );
}

function mergeAndDispose(parts) {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged;
}

function buildBicycleGeometry(type) {
    const cargo = type.variant === 'cargo';
    const rearZ = cargo ? -0.82 : -0.67;
    const frontZ = cargo ? 0.93 : 0.67;
    const axleY = 0.36;
    const frame = [];
    const tires = [];
    const rider = [];

    for (const z of [rearZ, frontZ]) {
        tires.push(transformedGeometry(
            new THREE.TorusGeometry(0.34, 0.038, 6, 16),
            { x: 0, y: axleY, z },
            { x: 1, y: 1, z: 1 },
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
        ));
        tires.push(tubeBetween(
            { x: 0, y: axleY - 0.29, z },
            { x: 0, y: axleY + 0.29, z },
            0.012,
            4,
        ));
    }

    const crank = { x: 0, y: 0.48, z: -0.05 };
    const seat = { x: 0, y: 0.91, z: -0.22 };
    const handle = { x: 0, y: 0.96, z: cargo ? 0.72 : 0.52 };
    frame.push(
        tubeBetween({ x: 0, y: axleY, z: rearZ }, crank),
        tubeBetween(crank, { x: 0, y: axleY, z: frontZ }),
        tubeBetween({ x: 0, y: axleY, z: rearZ }, seat),
        tubeBetween(seat, crank),
        tubeBetween(seat, handle),
        tubeBetween({ x: -0.28, y: handle.y, z: handle.z }, { x: 0.28, y: handle.y, z: handle.z }, 0.025),
    );
    frame.push(transformedGeometry(
        new THREE.BoxGeometry(1, 1, 1),
        { x: 0, y: seat.y + 0.035, z: seat.z - 0.02 },
        { x: 0.34, y: 0.07, z: 0.18 },
    ));
    if (cargo) {
        frame.push(transformedGeometry(
            new THREE.BoxGeometry(1, 1, 1),
            { x: 0, y: 0.62, z: 0.34 },
            { x: 0.70, y: 0.48, z: 0.68 },
        ));
    }

    // The courier is part of the vehicle batch, not a separately interactive
    // pedestrian. GTA's non-interaction rule for ambient people remains intact.
    rider.push(
        tubeBetween({ x: 0, y: 1.04, z: -0.18 }, { x: 0, y: 1.52, z: -0.10 }, 0.12, 7),
        tubeBetween({ x: -0.08, y: 1.10, z: -0.12 }, { x: -0.12, y: 0.58, z: 0.02 }, 0.045),
        tubeBetween({ x: 0.08, y: 1.10, z: -0.12 }, { x: 0.12, y: 0.58, z: 0.02 }, 0.045),
        tubeBetween({ x: -0.10, y: 1.40, z: -0.08 }, { x: -0.22, y: handle.y, z: handle.z }, 0.04),
        tubeBetween({ x: 0.10, y: 1.40, z: -0.08 }, { x: 0.22, y: handle.y, z: handle.z }, 0.04),
        transformedGeometry(
            new THREE.SphereGeometry(1, 8, 6),
            { x: 0, y: 1.68, z: -0.06 },
            { x: 0.13, y: 0.145, z: 0.13 },
        ),
    );

    const materialBatches = [
        mergeAndDispose(frame),
        mergeAndDispose(tires),
        mergeAndDispose(rider),
    ];
    const geometry = mergeGeometries(materialBatches, true);
    for (const batch of materialBatches) batch.dispose();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    registerShared(geometry);
    return geometry;
}

export function createBicycleMesh(type, hex) {
    const key = type?.variant === 'cargo' ? 'cargo' : 'standard';
    let geometry = geometryByType.get(key);
    if (!geometry) {
        geometry = buildBicycleGeometry({ variant: key });
        geometryByType.set(key, geometry);
    }
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, [
        materialForFrame(hex),
        getTireMaterial(),
        getRiderMaterial(),
    ]);
    mesh.castShadow = true;
    group.add(mesh);
    group.userData.vehicleKind = 'bicycle';
    group.userData.bicycleVariant = key;
    return group;
}

// Bicycle geometry/materials are shared across all traffic instances, but the
// traffic fleet itself is session-owned. Clear the cache at the same boundary
// as cars.js so a bicycle type first encountered on a later open cannot grow
// renderer.info.memory after the closed-session baseline was captured.
export function disposeBicycleSessionCaches() {
    const resources = new Set([
        ...geometryByType.values(),
        ...frameMaterials.values(),
        tireMaterial,
        riderMaterial,
    ]);
    for (const resource of resources) {
        if (!resource) continue;
        unregisterShared(resource);
        resource.dispose();
    }
    geometryByType.clear();
    frameMaterials.clear();
    tireMaterial = null;
    riderMaterial = null;
}
