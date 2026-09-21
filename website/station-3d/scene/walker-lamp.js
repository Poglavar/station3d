// The walker's own handheld lamp: a single real SpotLight that rides the
// walk-mode camera, throwing a warm cone forward and down onto the pavement
// and nearby walls. This is the ONLY real dynamic light we add at night — the
// streetlamp and car pools are faked with additive glow geometry — so keeping
// it to one spotlight is deliberate.
//
// cab.js owns the camera pose, so it calls updateWalkerLamp() each walk frame
// with the eye position + forward vector and whether it's dark enough to be on.

import * as THREE from 'three';
import { scene } from './setup.js';

const LAMP_COLOR = 0xffe6b0;      // warm white
const LAMP_INTENSITY = 4.2 * Math.PI;  // π-scaled to match setup.js's convention
const LAMP_DISTANCE = 42;         // reach (m)
const LAMP_ANGLE = 0.62;          // cone half-angle (rad)
const LAMP_PENUMBRA = 0.5;        // soft edge
const AIM_AHEAD = 8;              // metres in front the cone is aimed
const AIM_DROP = 4.5;             // metres below eye the aim point sits (look down)

let spot = null;
let target = null;

function ensureLamp() {
    if (spot) return;
    spot = new THREE.SpotLight(LAMP_COLOR, 0, LAMP_DISTANCE, LAMP_ANGLE, LAMP_PENUMBRA, 1.2);
    spot.castShadow = false;      // one more shadow map isn't worth it for a roaming cone
    target = new THREE.Object3D();
    scene.add(spot);
    scene.add(target);
    spot.target = target;
}

// eyeX/eyeY/eyeZ — camera position; fx/fz — normalised forward heading (XZ).
// `on` gates the whole thing (walk mode AND night). When off the light is
// parked at zero intensity but left in the graph (cheap, avoids re-adding).
export function updateWalkerLamp(eyeX, eyeY, eyeZ, fx, fz, on) {
    if (!on) {
        if (spot) spot.intensity = 0;
        return;
    }
    ensureLamp();
    spot.position.set(eyeX, eyeY, eyeZ);
    target.position.set(eyeX + fx * AIM_AHEAD, eyeY - AIM_DROP, eyeZ + fz * AIM_AHEAD);
    spot.intensity = LAMP_INTENSITY;
}

export function disposeWalkerLamp() {
    if (spot) {
        if (spot.parent) spot.parent.remove(spot);
        spot.dispose();
        spot = null;
    }
    if (target) {
        if (target.parent) target.parent.remove(target);
        target = null;
    }
}
