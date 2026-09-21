// Pure deterministic raster generation for exposed building-foundation
// concrete. The colour map carries aggregate, pour joints, mineral blooms,
// runoff and hairline cracks. The field is periodic, so one shared GPU texture
// can cover every skirt without a visible tile boundary or per-building material.

const TAU = Math.PI * 2;

function mixUint32(value) {
    let hash = value >>> 0;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function unit(seed, a, b = 0) {
    return mixUint32(
        (seed >>> 0)
        ^ Math.imul(a | 0, 0x9e3779b1)
        ^ Math.imul(b | 0, 0x85ebca77),
    ) / 0x100000000;
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function positiveModulo(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
}

function smooth(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

function wrappedDistance(a, b) {
    const distance = Math.abs(a - b);
    return Math.min(distance, 1 - distance);
}

function periodicValueNoise(u, v, cells, seed) {
    const gridX = u * cells;
    const gridY = v * cells;
    const cellX = Math.floor(gridX);
    const cellY = Math.floor(gridY);
    const nextX = (cellX + 1) % cells;
    const nextY = (cellY + 1) % cells;
    const x0 = positiveModulo(cellX, cells);
    const y0 = positiveModulo(cellY, cells);
    const tx = smooth(gridX - cellX);
    const ty = smooth(gridY - cellY);
    const a = unit(seed, x0, y0);
    const b = unit(seed, nextX, y0);
    const c = unit(seed, x0, nextY);
    const d = unit(seed, nextX, nextY);
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
}

function repeatedLineDistance(value, repeats, phase) {
    const cell = positiveModulo(value * repeats + phase, 1);
    return Math.min(cell, 1 - cell) / repeats;
}

export function createFoundationWeatheringRaster(size = 256, seed = 0x5f0a7d) {
    const safeSize = Math.max(32, Math.round(Number(size) || 256));
    const color = new Uint8Array(safeSize * safeSize * 4);
    const horizontalJointPhase = unit(seed, 1, 71);
    const verticalJointPhase = unit(seed, 2, 71);
    const streaks = Array.from({ length: 11 }, (_value, index) => ({
        u: unit(seed, index, 81),
        width: 0.006 + unit(seed, index, 82) * 0.026,
        strength: 0.28 + unit(seed, index, 83) * 0.58,
        frequency: 1 + Math.floor(unit(seed, index, 84) * 3),
        phase: unit(seed, index, 85),
    }));
    const blooms = Array.from({ length: 9 }, (_value, index) => ({
        u: unit(seed, index, 91),
        v: unit(seed, index, 92),
        radius: 0.035 + unit(seed, index, 93) * 0.105,
        strength: 0.35 + unit(seed, index, 94) * 0.55,
    }));
    const cracks = Array.from({ length: 4 }, (_value, index) => ({
        u: unit(seed, index, 101),
        amplitude: 0.008 + unit(seed, index, 102) * 0.021,
        frequency: 1 + Math.floor(unit(seed, index, 103) * 3),
        phase: unit(seed, index, 104),
        width: 0.0012 + unit(seed, index, 105) * 0.0018,
    }));

    for (let y = 0; y < safeSize; y++) {
        const v = y / safeSize;
        for (let x = 0; x < safeSize; x++) {
            const u = x / safeSize;
            const coarse = periodicValueNoise(u, v, 4, seed ^ 0x2d13a5);
            const medium = periodicValueNoise(u, v, 13, seed ^ 0x75b4c1);
            const fine = periodicValueNoise(u, v, 47, seed ^ 0xa0913f);
            const grain = unit(seed, x + y * safeSize, 121) - 0.5;

            let runoff = 0;
            for (const streak of streaks) {
                const distance = wrappedDistance(u, streak.u);
                const core = Math.exp(-0.5 * (distance / streak.width) ** 2);
                const verticalVariation = 0.42 + 0.58 * (
                    0.5 + 0.5 * Math.sin(TAU * (v * streak.frequency + streak.phase))
                ) ** 2;
                runoff += core * streak.strength * verticalVariation;
            }
            runoff = Math.min(1, runoff);

            let mineralBloom = 0;
            for (const bloom of blooms) {
                const dx = wrappedDistance(u, bloom.u);
                const dy = wrappedDistance(v, bloom.v);
                mineralBloom += Math.exp(
                    -(dx * dx + dy * dy) / (2 * bloom.radius * bloom.radius),
                ) * bloom.strength;
            }
            mineralBloom = Math.min(1, mineralBloom);

            const horizontalJointDistance = repeatedLineDistance(v, 4, horizontalJointPhase);
            const verticalJointDistance = repeatedLineDistance(u, 2, verticalJointPhase);
            const horizontalJoint = Math.exp(-((horizontalJointDistance / 0.0045) ** 2));
            const verticalJoint = Math.exp(-((verticalJointDistance / 0.0035) ** 2));

            let crackField = 0;
            for (const crack of cracks) {
                const centre = positiveModulo(
                    crack.u + crack.amplitude * Math.sin(
                        TAU * (v * crack.frequency + crack.phase),
                    ),
                    1,
                );
                const distance = wrappedDistance(u, centre);
                crackField = Math.max(
                    crackField,
                    Math.exp(-((distance / crack.width) ** 2)),
                );
            }

            const aggregate = Math.abs(grain) > 0.482
                ? (grain > 0 ? 12 : -15)
                : 0;
            const surface = (coarse - 0.5) * 18
                + (medium - 0.5) * 11
                + (fine - 0.5) * 7
                + grain * 7
                + aggregate;
            const jointDarkening = horizontalJoint * 8 + verticalJoint * 5;
            const darkening = runoff * 27 + jointDarkening + crackField * 31;
            const lightening = mineralBloom * 18;
            const index = (y * safeSize + x) * 4;

            color[index] = clampByte(232 + surface + lightening - darkening - runoff * 4);
            color[index + 1] = clampByte(
                230 + surface * 0.95 + lightening * 0.98 - darkening * 0.90,
            );
            color[index + 2] = clampByte(
                224 + surface * 0.80 + lightening * 1.04 - darkening * 0.72 - runoff * 3,
            );
            color[index + 3] = 255;
        }
    }

    return { size: safeSize, color };
}
