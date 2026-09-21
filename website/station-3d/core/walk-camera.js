export const WALK_CAMERA_MODES = Object.freeze(['first', 'third']);

export function nextWalkCameraMode(current) {
    return current === 'third' ? 'first' : 'third';
}

export function walkCameraModeAfterVehicleExit() {
    return 'third';
}

// Whether the player's own walker body is drawn. Third person shows it; a film
// shows it even to a first-person player, because the film is of the walker.
// A dialogue shot never does: its camera sits on the player's side of the
// speaker, so the body would stand between the lens and the face it frames.
// Nor does a film whose set piece carries its own stand-in for the player (the
// Adriatic helmsman): the walker would be a second player wherever the scene
// started him.
export function walkerAvatarVisible({
    walkMode = false,
    walkCameraMode = 'first',
    filmActive = false,
    dialogueShotActive = false,
    standInFilming = false,
    driving = false,
    terrainReady = false,
    airborne = false,
} = {}) {
    // An airborne walker has an explicit simulated position and does not need
    // a ground publication to remain visible. Streaming ground queries can
    // briefly miss while a parachutist drifts across tile boundaries; hiding
    // the whole group there made both the person and canopy flicker.
    if (!walkMode || driving || (!terrainReady && !airborne) || dialogueShotActive || standInFilming) return false;
    return walkCameraMode === 'third' || filmActive === true;
}

export function thirdPersonWalkCameraPose({
    x = 0,
    feetY = 0,
    z = 0,
    forwardX = 0,
    forwardZ = -1,
    pitchRad = 0,
    distanceM = 5.2,
    heightM = 2.7,
    lookAheadM = 2.1,
} = {}) {
    const length = Math.hypot(forwardX, forwardZ) || 1;
    const fx = forwardX / length;
    const fz = forwardZ / length;
    const pitch = Math.max(-0.6, Math.min(0.6, Number(pitchRad) || 0));
    return {
        x: x - fx * distanceM,
        y: feetY + heightM,
        z: z - fz * distanceM,
        lookX: x + fx * lookAheadM,
        lookY: feetY + 1.08 + Math.tan(pitch) * 3.2,
        lookZ: z + fz * lookAheadM,
    };
}

// Shorten the eye-to-camera segment against the same upright civil walls used
// by walking. This changes camera placement only; support/roof traversal keeps
// its existing policy. The slab test also handles a camera under a low ceiling.
export function resolveWalkCameraPose(target, desired, boxes = [], paddingM = .22) {
    let nearest = 1;
    for (const box of boxes) {
        const dx = target.x - box.cx, dz = target.z - box.cz;
        const start = [dx * box.cos - dz * box.sin, target.y, dx * box.sin + dz * box.cos];
        const vx = desired.x - target.x, vz = desired.z - target.z;
        const delta = [vx * box.cos - vz * box.sin, desired.y - target.y, vx * box.sin + vz * box.cos];
        const low = [-box.hx - paddingM, box.minY - paddingM, -box.hz - paddingM];
        const high = [box.hx + paddingM, box.maxY + paddingM, box.hz + paddingM];
        let enter = 0, leave = 1;
        for (let axis = 0; axis < 3; axis++) {
            if (Math.abs(delta[axis]) < 1e-9) {
                if (start[axis] < low[axis] || start[axis] > high[axis]) { enter = 2; break; }
                continue;
            }
            const a = (low[axis] - start[axis]) / delta[axis];
            const b = (high[axis] - start[axis]) / delta[axis];
            enter = Math.max(enter, Math.min(a, b));
            leave = Math.min(leave, Math.max(a, b));
        }
        if (enter <= leave && leave >= 0 && enter < nearest) nearest = Math.max(0, enter - .01);
    }
    if (nearest === 1) return desired;
    return { ...desired,
        x: target.x + (desired.x - target.x) * nearest,
        y: target.y + (desired.y - target.y) * nearest,
        z: target.z + (desired.z - target.z) * nearest,
    };
}
