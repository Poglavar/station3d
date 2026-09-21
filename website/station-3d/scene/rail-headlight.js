// Owns the single real spotlight used by the player-controlled heavy train at
// night; the light stays scene-level so first-person mesh hiding cannot hide it.

import * as THREE from 'three';

import { resolveRailHeadlightFrame } from '../core/rail-headlight.js';
import { scene } from './setup.js';

const HEADLIGHT_COLOR = 0xfff1c4;
const HEADLIGHT_INTENSITY = 28 * Math.PI;
const HEADLIGHT_DISTANCE_M = 150;
const HEADLIGHT_ANGLE_RAD = 0.32;
const HEADLIGHT_PENUMBRA = 0.55;
const HEADLIGHT_DECAY = 1.2;

let spot = null;
let target = null;

function ensureRailHeadlight() {
    if (spot) return;
    spot = new THREE.SpotLight(
        HEADLIGHT_COLOR,
        0,
        HEADLIGHT_DISTANCE_M,
        HEADLIGHT_ANGLE_RAD,
        HEADLIGHT_PENUMBRA,
        HEADLIGHT_DECAY,
    );
    spot.name = 'PlayerRailHeadlight';
    spot.castShadow = false;
    target = new THREE.Object3D();
    target.name = 'PlayerRailHeadlightTarget';
    scene.add(spot);
    scene.add(target);
    spot.target = target;
}

export function updateRailHeadlight(input) {
    const frame = resolveRailHeadlightFrame(input);
    if (!frame) {
        if (spot) spot.intensity = 0;
        return null;
    }
    ensureRailHeadlight();
    spot.position.set(frame.position.x, frame.position.y, frame.position.z);
    target.position.set(frame.target.x, frame.target.y, frame.target.z);
    spot.intensity = HEADLIGHT_INTENSITY;
    return frame;
}

export function disposeRailHeadlight() {
    if (spot) {
        spot.removeFromParent();
        spot.dispose();
        spot = null;
    }
    if (target) {
        target.removeFromParent();
        target = null;
    }
}
