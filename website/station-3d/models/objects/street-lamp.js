// Shared street-lamp model resources; road placement and surface light selection stay in the world layer.
import * as THREE from 'three';
import { registerShared } from '../../core/dispose.js';

export const POLE_H = 5.4;
export const LENS_Y = POLE_H + 0.055;
export const CAP_Y = POLE_H + 0.18;
const NIGHT_HEAD_EMISSIVE = 3.0;
let modelNight = false;
let poleGeo = null, headGeo = null, capGeo = null;
let poleMat = null, headMat = null, capMat = null;
export function getPoleGeometry() {
    if (poleGeo) return poleGeo;
    // Base at y=0, tapering slightly to the top. 6 sides is plenty at street
    // distance and keeps the instanced buffer small.
    poleGeo = new THREE.CylinderGeometry(0.085, 0.13, POLE_H, 6);
    poleGeo.translate(0, POLE_H / 2, 0);
    registerShared(poleGeo);
    return poleGeo;
}

export function getHeadGeometry() {
    if (headGeo) return headGeo;
    // A thin luminous lens on the underside; the opaque cap above it makes the
    // fixture read as a shielded downlight rather than a glowing cube.
    headGeo = new THREE.BoxGeometry(0.56, 0.055, 0.30);
    registerShared(headGeo);
    return headGeo;
}

export function getCapGeometry() {
    if (capGeo) return capGeo;
    capGeo = new THREE.BoxGeometry(0.82, 0.18, 0.54);
    registerShared(capGeo);
    return capGeo;
}

export function getPoleMaterial() {
    if (poleMat) return poleMat;
    poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7, metalness: 0.3 });
    registerShared(poleMat);
    return poleMat;
}

export function getHeadMaterial() {
    if (headMat) return headMat;
    // Dark grey when off (day); warm amber emissive flipped on at night.
    headMat = new THREE.MeshStandardMaterial({
        color: 0x3a3a3a,
        roughness: 0.5,
        emissive: 0xffd07a,
        emissiveIntensity: modelNight ? NIGHT_HEAD_EMISSIVE : 0,
    });
    registerShared(headMat);
    return headMat;
}

export function getCapMaterial() {
    if (capMat) return capMat;
    capMat = new THREE.MeshStandardMaterial({
        color: 0x22262a,
        roughness: 0.68,
        metalness: 0.35,
    });
    registerShared(capMat);
    return capMat;
}

export function setStreetLampModelNight(night) {
    modelNight = night;
    if (headMat) headMat.emissiveIntensity = night ? NIGHT_HEAD_EMISSIVE : 0;
}
