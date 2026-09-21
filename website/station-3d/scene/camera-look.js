// Cab drag-to-look camera offset. While the user holds a finger / mouse button
// on the cab canvas, drag delta accumulates into target yaw / pitch offsets
// (clamped). Each frame the live offsets ease toward those targets, and on
// release the targets snap to 0 so the camera glides back to forward.

import { state } from '../state.js';

const MAX_YAW = 2.094;     // ~120°
const MAX_PITCH = 1.047;   // ~60°
const SENS = 0.005;        // rad per pixel of drag
const SMOOTH = 0.18;       // EMA factor for ease-in / ease-back

let active = false;
let pointerId = null;
let lastX = 0;
let lastY = 0;
let yaw = 0;
let pitch = 0;
let targetYaw = 0;
let targetPitch = 0;
let directAim = false;

export function bindCameraLook(domElement) {
    domElement.style.touchAction = 'none';

    domElement.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'cab') return;
        active = true;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        try { domElement.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    domElement.addEventListener('pointermove', (e) => {
        if (!active || state.mode !== 'cab') return;
        if (pointerId !== null && e.pointerId !== pointerId) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (directAim) {
            // Aim style: dragging right/up moves the crosshair and gun right/up.
            targetYaw   = Math.max(-MAX_YAW,   Math.min(MAX_YAW,   targetYaw   + dx * SENS));
            targetPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitch - dy * SENS));
        } else {
            // World-grab style: dragging the world right moves the view left.
            targetYaw   = Math.max(-MAX_YAW,   Math.min(MAX_YAW,   targetYaw   - dx * SENS));
            targetPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitch + dy * SENS));
        }
    });
    const release = (e) => {
        if (!active) return;
        if (pointerId !== null && e && e.pointerId !== pointerId) return;
        active = false;
        pointerId = null;
        targetYaw = 0;
        targetPitch = 0;
    };
    domElement.addEventListener('pointerup', release);
    domElement.addEventListener('pointercancel', release);
    domElement.addEventListener('pointerleave', release);
}

// Called every cab frame to ease live offsets toward the drag targets.
export function updateCameraLook() {
    yaw   += (targetYaw   - yaw)   * SMOOTH;
    pitch += (targetPitch - pitch) * SMOOTH;
}

export function getCameraLook() {
    return { yaw, pitch };
}

export function setCameraLookDirectAim(enabled) {
    directAim = !!enabled;
}

export function setCameraLookInstant(nextYaw = 0, nextPitch = 0) {
    yaw = nextYaw;
    pitch = nextPitch;
    targetYaw = nextYaw;
    targetPitch = nextPitch;
}

// Clears state on cab entry so a fresh ride never inherits a drag offset.
export function resetCameraLook() {
    active = false;
    pointerId = null;
    yaw = 0;
    pitch = 0;
    targetYaw = 0;
    targetPitch = 0;
    directAim = false;
}
