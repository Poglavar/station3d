// Builds the authored sandbag nest, operators, flag and turret; the world owns combat and placement.

import * as THREE from 'three';
import { registerShared, unregisterShared } from '../../core/dispose.js';

const sharedAssets = new Set();
let sandbagGeo = null;
let receiverGeo = null;
let barrelGeo = null;
let postGeo = null;
let muzzleFlashGeo = null;
let bulletGeo = null;
let impactGeo = null;
let poleGeo = null;
let flagGeo = null;
let operatorSphereGeo = null;
let operatorCylinderGeo = null;
let tripodLegGeo = null;
let bulletHoleGeo = null;

let sandbagMat = null;
let gunMat = null;
let muzzleMat = null;
let bulletMat = null;
let impactMat = null;
let poleMat = null;
let operatorSkinMat = null;
let operatorUniformMat = null;
let operatorHelmetMat = null;
let flagTexture = null;
let flagMat = null;
let bulletHoleMat = null;

function trackShared(ref) {
    if (ref) {
        registerShared(ref);
        sharedAssets.add(ref);
    }
    return ref;
}

export function disposeSharedAssets() {
    for (const ref of sharedAssets) {
        unregisterShared(ref);
        if (typeof ref.dispose === 'function') ref.dispose();
    }
    sharedAssets.clear();
    sandbagGeo = receiverGeo = barrelGeo = postGeo = muzzleFlashGeo = null;
    bulletGeo = impactGeo = poleGeo = flagGeo = null;
    operatorSphereGeo = operatorCylinderGeo = tripodLegGeo = bulletHoleGeo = null;
    sandbagMat = gunMat = muzzleMat = bulletMat = impactMat = poleMat = null;
    operatorSkinMat = operatorUniformMat = operatorHelmetMat = null;
    flagTexture = flagMat = bulletHoleMat = null;
}

export function stableHash(value) {
    const text = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function seededUnit(seed, salt) {
    const x = Math.sin((seed + 1) * (salt + 23) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

function getSandbagGeo() {
    if (!sandbagGeo) sandbagGeo = trackShared(new THREE.BoxGeometry(0.68, 0.24, 0.32));
    return sandbagGeo;
}
function getReceiverGeo() {
    if (!receiverGeo) receiverGeo = trackShared(new THREE.BoxGeometry(0.34, 0.22, 0.46));
    return receiverGeo;
}
function getBarrelGeo() {
    if (!barrelGeo) {
        barrelGeo = new THREE.CylinderGeometry(0.045, 0.06, 1.45, 12);
        barrelGeo.rotateX(Math.PI / 2);
        trackShared(barrelGeo);
    }
    return barrelGeo;
}
function getPostGeo() {
    if (!postGeo) postGeo = trackShared(new THREE.CylinderGeometry(0.08, 0.12, 0.56, 10));
    return postGeo;
}
function getMuzzleFlashGeo() {
    if (!muzzleFlashGeo) muzzleFlashGeo = trackShared(new THREE.SphereGeometry(0.18, 10, 8));
    return muzzleFlashGeo;
}
export function getBulletGeo() {
    if (!bulletGeo) {
        bulletGeo = new THREE.CylinderGeometry(0.035, 0.052, 0.78, 8);
        trackShared(bulletGeo);
    }
    return bulletGeo;
}
export function getImpactGeo() {
    if (!impactGeo) impactGeo = trackShared(new THREE.SphereGeometry(0.075, 6, 4));
    return impactGeo;
}
function getPoleGeo() {
    if (!poleGeo) poleGeo = trackShared(new THREE.CylinderGeometry(0.035, 0.045, 1.55, 8));
    return poleGeo;
}
function getFlagGeo() {
    if (!flagGeo) flagGeo = trackShared(new THREE.PlaneGeometry(0.72, 0.42));
    return flagGeo;
}
function getOperatorSphereGeo() {
    if (!operatorSphereGeo) operatorSphereGeo = trackShared(new THREE.SphereGeometry(1, 10, 8));
    return operatorSphereGeo;
}
function getOperatorCylinderGeo() {
    if (!operatorCylinderGeo) operatorCylinderGeo = trackShared(new THREE.CylinderGeometry(1, 1, 1, 10));
    return operatorCylinderGeo;
}
function getTripodLegGeo() {
    if (!tripodLegGeo) {
        tripodLegGeo = new THREE.CylinderGeometry(0.025, 0.035, 0.92, 8);
        trackShared(tripodLegGeo);
    }
    return tripodLegGeo;
}
export function getBulletHoleGeo() {
    if (!bulletHoleGeo) bulletHoleGeo = trackShared(new THREE.CircleGeometry(0.07, 10));
    return bulletHoleGeo;
}

function getSandbagMat() {
    if (!sandbagMat) {
        sandbagMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0x9b8357,
            roughness: 0.96,
            metalness: 0.0,
        }));
    }
    return sandbagMat;
}
function getGunMat() {
    if (!gunMat) {
        gunMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0x17191a,
            roughness: 0.44,
            metalness: 0.82,
        }));
    }
    return gunMat;
}
function getMuzzleMat() {
    if (!muzzleMat) {
        muzzleMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0xffd0a0,
            emissive: 0xff4018,
            emissiveIntensity: 4.0,
            transparent: true,
            opacity: 0.95,
        }));
    }
    return muzzleMat;
}
export function getBulletMat() {
    if (!bulletMat) {
        bulletMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0xff5538,
            emissive: 0xff2a12,
            emissiveIntensity: 3.6,
            roughness: 0.30,
        }));
    }
    return bulletMat;
}
export function getImpactMat() {
    if (!impactMat) {
        impactMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0xffb070,
            emissive: 0xff4010,
            emissiveIntensity: 3.2,
        }));
    }
    return impactMat;
}
function getPoleMat() {
    if (!poleMat) {
        poleMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0x5b6470,
            roughness: 0.45,
            metalness: 0.60,
        }));
    }
    return poleMat;
}
function getOperatorSkinMat() {
    if (!operatorSkinMat) {
        operatorSkinMat = trackShared(new THREE.MeshStandardMaterial({ color: 0xd8a080, roughness: 0.70 }));
    }
    return operatorSkinMat;
}
function getOperatorUniformMat() {
    if (!operatorUniformMat) {
        operatorUniformMat = trackShared(new THREE.MeshStandardMaterial({ color: 0x5a2727, roughness: 0.82 }));
    }
    return operatorUniformMat;
}
function getOperatorHelmetMat() {
    if (!operatorHelmetMat) {
        operatorHelmetMat = trackShared(new THREE.MeshStandardMaterial({ color: 0x3a3425, roughness: 0.76 }));
    }
    return operatorHelmetMat;
}
export function getBulletHoleMat() {
    if (!bulletHoleMat) {
        bulletHoleMat = trackShared(new THREE.MeshStandardMaterial({
            color: 0x080808,
            roughness: 1.0,
            metalness: 0.0,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        }));
    }
    return bulletHoleMat;
}

function getFlagTexture() {
    if (flagTexture) return flagTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 112;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9f1d22';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f5d04a';
    ctx.font = 'bold 78px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☭', canvas.width * 0.50, canvas.height * 0.56);
    flagTexture = trackShared(new THREE.CanvasTexture(canvas));
    flagTexture.needsUpdate = true;
    return flagTexture;
}

function getFlagMat() {
    if (!flagMat) {
        flagMat = trackShared(new THREE.MeshStandardMaterial({
            map: getFlagTexture(),
            side: THREE.DoubleSide,
            roughness: 0.88,
            metalness: 0.02,
        }));
    }
    return flagMat;
}

function addSandbags(root) {
    const geo = getSandbagGeo();
    const mat = getSandbagMat();
    const bagCount = 12;
    for (let layer = 0; layer < 2; layer++) {
        for (let i = 0; i < bagCount; i++) {
            const a = -Math.PI * 0.84 + (i / (bagCount - 1)) * Math.PI * 1.68;
            const radius = 1.10 - layer * 0.08;
            const bag = new THREE.Mesh(geo, mat);
            bag.position.set(Math.sin(a) * radius, 0.16 + layer * 0.22, Math.cos(a) * radius * 0.82);
            bag.rotation.y = a + Math.PI / 2;
            bag.rotation.z = (i % 2 === 0 ? 0.05 : -0.05);
            bag.castShadow = true;
            bag.receiveShadow = true;
            root.add(bag);
        }
    }
}

function addOperator(root, x, z, seed) {
    const holder = new THREE.Group();
    holder.position.set(x, 0.02, z);
    holder.rotation.y = (seededUnit(seed, Math.floor(x * 1000) + 3) - 0.5) * 0.35;

    const body = new THREE.Mesh(getOperatorCylinderGeo(), getOperatorUniformMat());
    body.position.y = 0.72;
    body.scale.set(0.14, 0.46, 0.14);
    body.castShadow = true;
    holder.add(body);

    const head = new THREE.Mesh(getOperatorSphereGeo(), getOperatorSkinMat());
    head.position.y = 1.26;
    head.scale.set(0.14, 0.16, 0.14);
    head.castShadow = true;
    holder.add(head);

    const helmet = new THREE.Mesh(getOperatorSphereGeo(), getOperatorHelmetMat());
    helmet.position.y = 1.37;
    helmet.scale.set(0.15, 0.07, 0.15);
    helmet.castShadow = true;
    holder.add(helmet);

    for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(getOperatorCylinderGeo(), getOperatorUniformMat());
        leg.position.set(sx * 0.055, 0.29, 0.02);
        leg.scale.set(0.035, 0.35, 0.035);
        leg.castShadow = true;
        holder.add(leg);
    }
    root.add(holder);
}

function addFlag(root) {
    const pole = new THREE.Mesh(getPoleGeo(), getPoleMat());
    pole.position.set(-1.00, 0.82, -0.78);
    pole.castShadow = true;
    root.add(pole);

    const flag = new THREE.Mesh(getFlagGeo(), getFlagMat());
    flag.position.set(-0.63, 1.30, -0.78);
    flag.rotation.y = 0.15;
    flag.castShadow = true;
    flag.renderOrder = 18;
    root.add(flag);
}

function addGun(root) {
    const gunMat = getGunMat();
    const post = new THREE.Mesh(getPostGeo(), gunMat);
    post.position.set(0, 0.52, 0);
    post.castShadow = true;
    root.add(post);

    for (const a of [Math.PI * 0.10, Math.PI * 0.76, -Math.PI * 0.76]) {
        const leg = new THREE.Mesh(getTripodLegGeo(), gunMat);
        leg.position.set(Math.sin(a) * 0.30, 0.38, Math.cos(a) * 0.30);
        leg.rotation.z = Math.sin(a) * 0.55;
        leg.rotation.x = -Math.cos(a) * 0.55;
        leg.castShadow = true;
        root.add(leg);
    }

    const turret = new THREE.Group();
    turret.position.set(0, 0.86, 0.08);
    root.add(turret);

    const receiver = new THREE.Mesh(getReceiverGeo(), gunMat);
    receiver.position.set(0, 0.04, 0.22);
    receiver.castShadow = true;
    turret.add(receiver);

    const barrel = new THREE.Mesh(getBarrelGeo(), gunMat);
    barrel.position.set(0, 0.04, 0.96);
    barrel.castShadow = true;
    turret.add(barrel);

    const flash = new THREE.Mesh(getMuzzleFlashGeo(), getMuzzleMat());
    flash.position.set(0, 0.04, 1.72);
    flash.visible = false;
    turret.add(flash);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.04, 1.82);
    turret.add(muzzle);

    return { yawGroup: turret, muzzle, flash, flashTtl: 0 };
}

export function createMachineGunNestModel(seed) {
    const group = new THREE.Group();
    addSandbags(group);
    const turret = addGun(group);
    addOperator(group, -0.46, -0.46, seed);
    addOperator(group, 0.48, -0.58, seed + 13);
    addFlag(group);
    return { group, turret };
}
