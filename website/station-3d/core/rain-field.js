// Deterministic static attributes for the one-draw-call GPU rain field.
// The shader turns these seeds into camera-centred falling streaks.

export const RAIN_PARTICLE_COUNTS = Object.freeze({
    high: 1400,
    medium: 900,
    low: 550,
});

export function rainParticleCountForQuality(profileId) {
    return RAIN_PARTICLE_COUNTS[profileId] || RAIN_PARTICLE_COUNTS.medium;
}

function seededRandom(seed) {
    let state = (Number(seed) >>> 0) || 0x6d2b79f5;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function buildRainField(count, seed = 0x51a7c0de) {
    const particleCount = Math.max(1, Math.floor(Number(count) || 1));
    const random = seededRandom(seed);
    const positions = new Float32Array(particleCount * 3);
    const phases = new Float32Array(particleCount);
    const scales = new Float32Array(particleCount);
    for (let index = 0; index < particleCount; index++) {
        const angle = random() * Math.PI * 2;
        const radius = Math.sqrt(random());
        positions[index * 3] = Math.cos(angle) * radius;
        positions[index * 3 + 1] = random();
        positions[index * 3 + 2] = Math.sin(angle) * radius;
        phases[index] = random();
        scales[index] = 0.45 + random() * 0.55;
    }
    return Object.freeze({ positions, phases, scales, count: particleCount });
}
