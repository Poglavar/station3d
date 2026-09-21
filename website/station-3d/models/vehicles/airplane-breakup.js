// A short, deterministic visual-only breakup for the existing airplane model.
// It moves named model roots only: no debris meshes, particles, physics, or
// per-frame allocations are needed.

const BREAKUP_DURATION_S = 1.7;

const PARTS = Object.freeze([
    { name: 'GtaAirplaneRoundedMainWing', offset: [-1.65, -0.5, 0.18], spin: [0.18, -0.5, -0.24] },
    { name: 'GtaAirplaneRoundedTailplane', offset: [0.74, -0.28, -0.78], spin: [0.28, 0.62, 0.16] },
    { name: 'GtaAirplaneRoundedFin', offset: [-0.48, -0.14, -0.9], spin: [0.52, -0.24, -0.38] },
    { name: 'GtaAirplaneLandingGear', offset: [0.2, -0.68, 0.46], spin: [0.35, 0.12, 0.52] },
    { name: 'GtaAirplanePropeller', offset: [0.06, -0.16, 0.92], spin: [0.64, -0.18, 1.18] },
]);

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function settleEase(value) {
    const t = clamp01(value);
    // Decelerating motion that cannot overshoot or keep drifting after impact.
    return 1 - Math.pow(1 - t, 3);
}

function capturePart(root, spec) {
    const object = root?.getObjectByName?.(spec.name);
    if (!object) return null;
    return {
        object,
        spec,
        position: object.position.clone(),
        rotation: object.rotation.clone(),
        scale: object.scale.clone(),
    };
}

// The controller retains only the original transforms. `advance()` is safe to
// call repeatedly with the same elapsed value, making re-syncs idempotent.
export function createAirplaneBreakupController(root, { durationS = BREAKUP_DURATION_S } = {}) {
    const duration = Math.max(0.5, Math.min(2.5, Number(durationS) || BREAKUP_DURATION_S));
    const parts = PARTS.map(spec => capturePart(root, spec)).filter(Boolean);

    function apply(elapsedS) {
        const progress = clamp01((Number(elapsedS) || 0) / duration);
        const eased = settleEase(progress);
        for (const part of parts) {
            const { object, spec, position, rotation } = part;
            object.position.set(
                position.x + spec.offset[0] * eased,
                position.y + spec.offset[1] * eased,
                position.z + spec.offset[2] * eased,
            );
            object.rotation.set(
                rotation.x + spec.spin[0] * eased,
                rotation.y + spec.spin[1] * eased,
                rotation.z + spec.spin[2] * eased,
                rotation.order,
            );
        }
        return progress >= 1;
    }

    function reset() {
        for (const part of parts) {
            part.object.position.copy(part.position);
            part.object.rotation.copy(part.rotation);
            part.object.scale.copy(part.scale);
        }
    }

    return Object.freeze({
        durationS: duration,
        advance: apply,
        reset,
        settle: () => apply(duration),
    });
}

export { BREAKUP_DURATION_S };
