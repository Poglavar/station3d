// Aim maths for a vehicle-mounted gun.
//
// A first-person gun can simply copy the camera's transform. A gun bolted to a
// car cannot: it sits on the roof, it is visible from every camera angle, and
// it has to swing to where the player is looking without pointing through its
// own bodywork. This turns a look direction into a turret yaw/pitch and hands
// back the clamped direction its barrel actually ends up facing, so the mesh
// and the bullets can never disagree about where it is pointing.

// Depression is limited so the barrel cannot sweep down into the car's own
// roof; elevation is generous so you can shoot at anything worth shooting at.
export const MOUNTED_MIN_PITCH_RAD = -0.30;   // ≈ 17° down
export const MOUNTED_MAX_PITCH_RAD = 0.80;    // ≈ 46° up

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// `forward` is the direction the player is looking, in world space. Returns the
// turret's YXZ euler angles and the unit direction its barrel points along —
// which is the look direction with its pitch clamped, never the raw input.
export function mountedWeaponAim(forward, {
    minPitchRad = MOUNTED_MIN_PITCH_RAD,
    maxPitchRad = MOUNTED_MAX_PITCH_RAD,
} = {}) {
    const x = Number(forward?.x);
    const y = Number(forward?.y);
    const z = Number(forward?.z);
    const length = Math.hypot(x, y, z);
    // A zero or non-finite look vector means "straight ahead", not NaN.
    if (!Number.isFinite(length) || length < 1e-6) {
        return { yaw: 0, pitch: 0, dir: { x: 0, y: 0, z: -1 } };
    }
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;

    // The gun model points along -Z, matching the camera convention.
    const yaw = Math.atan2(-nx, -nz);
    const pitch = clamp(Math.asin(clamp(ny, -1, 1)), minPitchRad, maxPitchRad);
    const cosPitch = Math.cos(pitch);
    return {
        yaw,
        pitch,
        dir: {
            x: -Math.sin(yaw) * cosPitch,
            y: Math.sin(pitch),
            z: -Math.cos(yaw) * cosPitch,
        },
    };
}
