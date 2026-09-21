// Bounded low-poly dog and leash companion for ambient pedestrians. Each dog
// has a batched body, four shared head parts and a leash: seven bounded draws.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { registerShared, unregisterShared } from '../core/dispose.js';

const DOG_COAT_COLORS = [0x9a6336, 0x4b3427, 0xc49a6c, 0xd8c3a5, 0x252525];
const UP = new THREE.Vector3(0, 1, 0);
const coatMaterials = new Map();
let dogGeometry = null;
let detailMaterial = null;
let leashGeometry = null;
let leashMaterial = null;
let eyeWhiteMaterial = null;
let tongueMaterial = null;
let headGeometry = null;
let eyeGeometry = null;
let pupilGeometry = null;
let tongueGeometry = null;
let cachedHeadCoat = null;
let cachedHeadEyes = null;
let cachedHeadPupils = null;

function transformed(geometry, position, scale, quaternion = null) {
    geometry.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, position.y, position.z),
        quaternion || new THREE.Quaternion(),
        new THREE.Vector3(scale.x, scale.y, scale.z),
    ));
    return geometry;
}

function tubeBetween(from, to, radius, radialSegments = 6) {
    const direction = new THREE.Vector3(
        to.x - from.x,
        to.y - from.y,
        to.z - from.z,
    );
    const length = direction.length();
    return transformed(
        new THREE.CylinderGeometry(1, 1, 1, radialSegments),
        {
            x: (from.x + to.x) * 0.5,
            y: (from.y + to.y) * 0.5,
            z: (from.z + to.z) * 0.5,
        },
        { x: radius, y: length, z: radius },
        new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()),
    );
}

function mergeAndDispose(parts) {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged;
}

function getDogGeometry() {
    if (dogGeometry) return dogGeometry;
    const coat = [
        transformed(new THREE.SphereGeometry(1, 8, 6), { x: 0, y: 0.43, z: 0 }, { x: 0.22, y: 0.22, z: 0.42 }),
        tubeBetween({ x: 0, y: 0.48, z: -0.33 }, { x: 0, y: 0.78, z: -0.63 }, 0.035),
    ];
    for (const x of [-0.13, 0.13]) {
        for (const z of [-0.22, 0.22]) {
            coat.push(transformed(
                new THREE.CylinderGeometry(1, 1, 1, 6),
                { x, y: 0.17, z },
                { x: 0.045, y: 0.30, z: 0.045 },
            ));
        }
    }
    const details = [
        transformed(new THREE.TorusGeometry(0.20, 0.018, 4, 10), { x: 0, y: 0.58, z: 0.39 }, { x: 1, y: 1, z: 1 }, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5)),
    ];
    const batches = [mergeAndDispose(coat), mergeAndDispose(details)];
    dogGeometry = mergeGeometries(batches, true);
    for (const batch of batches) batch.dispose();
    dogGeometry.computeBoundingBox();
    dogGeometry.computeBoundingSphere();
    registerShared(dogGeometry);
    return dogGeometry;
}

function getHeadAssets() {
    if (!headGeometry) headGeometry = new THREE.SphereGeometry(1, 8, 6);
    if (!eyeGeometry) eyeGeometry = new THREE.SphereGeometry(1, 7, 5);
    if (!pupilGeometry) pupilGeometry = new THREE.SphereGeometry(1, 6, 4);
    if (!tongueGeometry) tongueGeometry = new THREE.SphereGeometry(1, 6, 4);
    if (!eyeWhiteMaterial) { eyeWhiteMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }); registerShared(eyeWhiteMaterial); }
    if (!tongueMaterial) { tongueMaterial = new THREE.MeshStandardMaterial({ color: 0xe98791, roughness: 0.7 }); registerShared(tongueMaterial); }
}

function createDogHead(coatMaterial) {
    getHeadAssets();
    const head = new THREE.Group();
    head.name = 'AmbientDogHead';
    if (!cachedHeadCoat) {
        cachedHeadCoat = mergeAndDispose([
            transformed(headGeometry.clone(), { x: 0, y: .03, z: 0 }, { x: .22, y: .23, z: .21 }),
            transformed(headGeometry.clone(), { x: 0, y: -.03, z: .20 }, { x: .12, y: .10, z: .17 }),
            ...[-.12, .12].map(x => transformed(headGeometry.clone(), { x, y: .20, z: -.02 }, { x: .075, y: .18, z: .075 })),
        ]);
        cachedHeadEyes = mergeAndDispose([-.075, .075].map(x => transformed(eyeGeometry.clone(),
            { x, y: .09, z: .19 }, { x: .045, y: .05, z: .025 })));
        cachedHeadPupils = mergeAndDispose([
            ...[-.075, .075].map(x => transformed(pupilGeometry.clone(),
                { x, y: .09, z: .214 }, { x: .018, y: .025, z: .008 })),
            transformed(pupilGeometry.clone(), { x: 0, y: -.005, z: .345 }, { x: .06, y: .045, z: .03 }),
        ]);
        for (const geometry of [cachedHeadCoat, cachedHeadEyes, cachedHeadPupils, tongueGeometry]) registerShared(geometry);
    }
    for (const [name, geometry, material] of [
        ['AmbientDogHeadCoat', cachedHeadCoat, coatMaterial],
        ['AmbientDogEyes', cachedHeadEyes, eyeWhiteMaterial],
        ['AmbientDogPupils', cachedHeadPupils, getDetailMaterial()],
    ]) {
        const mesh = new THREE.Mesh(geometry, material); mesh.name = name; head.add(mesh);
    }
    const tongue = new THREE.Mesh(tongueGeometry, tongueMaterial);
    tongue.name = 'AmbientDogTongue'; tongue.scale.set(.035, .035, .075);
    tongue.position.set(0, -.105, .27); tongue.visible = false;
    head.add(tongue); head.userData.tongue = tongue;
    return head;
}

function getCoatMaterial(hex) {
    const key = Number(hex) >>> 0;
    let material = coatMaterials.get(key);
    if (!material) {
        material = new THREE.MeshStandardMaterial({ color: key, roughness: 0.9 });
        coatMaterials.set(key, material);
        registerShared(material);
    }
    return material;
}

function getDetailMaterial() {
    if (!detailMaterial) {
        detailMaterial = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.86 });
        registerShared(detailMaterial);
    }
    return detailMaterial;
}

function getLeashGeometry() {
    if (!leashGeometry) {
        leashGeometry = new THREE.CylinderGeometry(0.009, 0.009, 1, 5);
        registerShared(leashGeometry);
    }
    return leashGeometry;
}

function getLeashMaterial() {
    if (!leashMaterial) {
        leashMaterial = new THREE.MeshBasicMaterial({ color: 0x9b1c31 });
        registerShared(leashMaterial);
    }
    return leashMaterial;
}

function positionLeash(leash, from, to) {
    const direction = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = Math.max(0.001, direction.length());
    leash.position.set(
        (from.x + to.x) * 0.5,
        (from.y + to.y) * 0.5,
        (from.z + to.z) * 0.5,
    );
    leash.scale.set(1, length, 1);
    leash.quaternion.setFromUnitVectors(UP, direction.normalize());
}

export function createLeashedDog({
    handlerX = 0,
    side = 1,
    random = Math.random,
} = {}) {
    const direction = side < 0 ? -1 : 1;
    const root = new THREE.Group();
    root.name = 'AmbientLeashedDog';
    const colorIndex = Math.min(
        DOG_COAT_COLORS.length - 1,
        Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * DOG_COAT_COLORS.length),
    );
    const dog = new THREE.Mesh(getDogGeometry(), [
        getCoatMaterial(DOG_COAT_COLORS[colorIndex]),
        getDetailMaterial(),
    ]);
    dog.name = 'AmbientDog';
    dog.position.set(handlerX + direction * 0.82, 0, 0.30);
    dog.castShadow = true;
    root.add(dog);
    const head = createDogHead(dog.material[0]);
    head.position.set(dog.position.x, dog.position.y + .58, dog.position.z + .39);
    root.add(head);

    const leash = new THREE.Mesh(getLeashGeometry(), getLeashMaterial());
    leash.name = 'AmbientDogLeash';
    root.add(leash);
    const leashFrom = { x: handlerX + direction * 0.18, y: 0.98, z: 0 };
    const collarOffset = { x: -direction * 0.05, y: 0.58, z: 0.40 };
    positionLeash(leash, leashFrom, {
        x: dog.position.x + collarOffset.x,
        y: dog.position.y + collarOffset.y,
        z: dog.position.z + collarOffset.z,
    });
    root.userData.dogMesh = dog;
    root.userData.head = head;
    root.userData.tongue = head.userData.tongue;
    root.userData.leashMesh = leash;
    root.userData.leashFrom = leashFrom;
    root.userData.collarOffset = collarOffset;
    root.userData.baseDogPosition = dog.position.clone();
    return root;
}

// Dogs are uncommon, which made their first procedural merge occur arbitrarily
// late in a ride. Prepare the shared mesh/material family behind world loading.
export function prepareDogMeshAssets() {
    getDogGeometry();
    getHeadAssets();
    getDetailMaterial();
    getLeashGeometry();
    getLeashMaterial();
    for (const color of DOG_COAT_COLORS) getCoatMaterial(color);
    return true;
}

export function animateLeashedDog(companion, phase, amount = 1) {
    const dog = companion?.userData?.dogMesh;
    const leash = companion?.userData?.leashMesh;
    if (!dog || !leash) return;
    const motion = Math.max(0, Math.min(1, Number(amount) || 0));
    const base = companion.userData.baseDogPosition;
    dog.position.y = base.y + Math.abs(Math.sin(phase * 2)) * 0.035 * motion;
    dog.position.z = base.z + Math.sin(phase) * 0.025 * motion;
    if (companion.userData.head) companion.userData.head.position.set(dog.position.x, dog.position.y + .58, dog.position.z + .39);
    const collar = companion.userData.collarOffset;
    positionLeash(leash, companion.userData.leashFrom, {
        x: dog.position.x + collar.x,
        y: dog.position.y + collar.y,
        z: dog.position.z + collar.z,
    });
}

export function setDogHappyPose(companion, { amount = 0, lookYaw = 0, lookPitch = 0, timeS = 0 } = {}) {
    const head = companion?.userData?.head;
    const tongue = companion?.userData?.tongue;
    if (!head) return;
    const a = Math.max(0, Math.min(1, Number(amount) || 0));
    head.rotation.y = Math.max(-0.65, Math.min(0.65, Number(lookYaw) || 0)) * a;
    head.rotation.x = Math.max(-0.45, Math.min(0.35, Number(lookPitch) || 0)) * a - 0.12 * a;
    if (tongue) {
        tongue.visible = a > 0.02;
        tongue.position.y = -0.105 - 0.018 * a * (0.5 + 0.5 * Math.sin(Number(timeS) * 8));
    }
}

export function disposeDogMeshSessionCaches() {
    const resources = new Set([
        dogGeometry,
        detailMaterial,
        leashGeometry,
        leashMaterial,
        eyeWhiteMaterial, tongueMaterial, headGeometry, eyeGeometry, pupilGeometry, tongueGeometry,
        cachedHeadCoat, cachedHeadEyes, cachedHeadPupils,
        ...coatMaterials.values(),
    ]);
    for (const resource of resources) {
        if (!resource) continue;
        unregisterShared(resource);
        resource.dispose();
    }
    dogGeometry = null;
    detailMaterial = null;
    leashGeometry = null;
    leashMaterial = null;
    eyeWhiteMaterial = null; tongueMaterial = null; headGeometry = null; eyeGeometry = null; pupilGeometry = null; tongueGeometry = null;
    cachedHeadCoat = null; cachedHeadEyes = null; cachedHeadPupils = null;
    coatMaterials.clear();
}
