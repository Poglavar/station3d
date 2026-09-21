// Pure tire-feedback model shared by the Rapier telemetry adapter, audio and
// the bounded skid-mark renderer.

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

// Ordinary urban steering and braking should stay quiet. Tyre squeal begins
// only above roughly 22 km/h and reaches full speed weighting around 65 km/h.
const TIRE_FEEDBACK_MIN_SPEED_MPS = 6;
const TIRE_FEEDBACK_FULL_SPEED_MPS = 18;

export function gtaTireEffectTargets({
    speedMps = 0,
    serviceBraking = false,
    handbrake = false,
    maxForwardImpulseNs = 0,
    maxSideImpulseNs = 0,
    contactCount = 0,
} = {}) {
    const speed = Math.abs(Number(speedMps) || 0);
    const speedFactor = clamp01(
        (speed - TIRE_FEEDBACK_MIN_SPEED_MPS)
        / (TIRE_FEEDBACK_FULL_SPEED_MPS - TIRE_FEEDBACK_MIN_SPEED_MPS),
    );
    const forwardSlip = clamp01((Math.abs(Number(maxForwardImpulseNs) || 0) - 8) / 34);
    const cornering = clamp01((Math.abs(Number(maxSideImpulseNs) || 0) - 5) / 22)
        * speedFactor;
    // A normal service-brake command is not itself a skid. It squeals only
    // when the wheel telemetry also reports forward slip; the handbrake is an
    // explicit lock-up request and may create feedback on its own.
    const brakeDemand = handbrake ? 1 : 0;
    const braking = Math.max(
        brakeDemand * speedFactor,
        serviceBraking || handbrake ? forwardSlip * speedFactor : 0,
    );
    const contactFactor = clamp01((Number(contactCount) || 0) / 2);
    const squeal = clamp01(Math.max(braking, cornering) * contactFactor);
    return {
        speedFactor,
        braking: clamp01(braking),
        cornering: clamp01(cornering),
        squeal,
        pitch: clamp01(0.25 + speed / 40 + cornering * 0.35),
    };
}

export function skidMarkQuad(previous, current, widthM = 0.18, yOffsetM = 0.018) {
    const values = [
        previous?.x, previous?.y, previous?.z,
        current?.x, current?.y, current?.z,
    ].map(Number);
    if (!values.every(Number.isFinite)) return null;
    const [px, py, pz, cx, cy, cz] = values;
    const dx = cx - px;
    const dz = cz - pz;
    const length = Math.hypot(dx, dz);
    if (length < 0.04) return null;
    const halfWidth = Math.max(0.02, Number(widthM) || 0.18) * 0.5;
    const sideX = -dz / length * halfWidth;
    const sideZ = dx / length * halfWidth;
    const previousY = py + (Number(yOffsetM) || 0);
    const currentY = cy + (Number(yOffsetM) || 0);
    return new Float32Array([
        px + sideX, previousY, pz + sideZ,
        cx + sideX, currentY, cz + sideZ,
        px - sideX, previousY, pz - sideZ,
        px - sideX, previousY, pz - sideZ,
        cx + sideX, currentY, cz + sideZ,
        cx - sideX, currentY, cz - sideZ,
    ]);
}
