// Pure pieces of the authored sky: the cloud and sun settings a scene authors,
// and a tileable fair-weather cloud field built once and uploaded as a
// repeating texture. The shader that draws them lives in scene/sky-dome.js.

import { finiteOrNull } from './math.js';

export const SKY_DEFAULTS = Object.freeze({
    clouds: Object.freeze({
        // Fraction of the sky the field covers: scattered summer cumulus.
        coverage: 0.42,
        // Cloud base above the sea.
        altitudeM: 1600,
        // Metres one texture repeat spans on the cloud layer.
        scaleM: 4200,
        // Drift east and south, metres per second.
        windMps: Object.freeze([5, 1.5]),
    }),
    sunDisc: true,
    lensFlare: true,
});

function positive(value, label) {
    const number = finiteOrNull(value);
    if (!(number > 0)) throw new Error(`sky: ${label} must be a positive number`);
    return number;
}

export function resolveSkyConfig(authored) {
    if (!authored) return null;
    const source = authored === true ? {} : authored;
    if (typeof source !== 'object') return null;
    let clouds = null;
    if (source.clouds !== false) {
        const merged = {
            ...SKY_DEFAULTS.clouds,
            ...(source.clouds && typeof source.clouds === 'object' ? source.clouds : {}),
        };
        const wind = Array.isArray(merged.windMps) ? merged.windMps : SKY_DEFAULTS.clouds.windMps;
        clouds = Object.freeze({
            coverage: Math.max(0, Math.min(1, finiteOrNull(merged.coverage) ?? SKY_DEFAULTS.clouds.coverage)),
            altitudeM: positive(merged.altitudeM, 'clouds.altitudeM'),
            scaleM: positive(merged.scaleM, 'clouds.scaleM'),
            windMps: Object.freeze([finiteOrNull(wind[0]) ?? 0, finiteOrNull(wind[1]) ?? 0]),
        });
    }
    return Object.freeze({
        clouds,
        sunDisc: source.sunDisc !== false,
        lensFlare: source.lensFlare !== false,
    });
}

function hashUnit(ix, iy, octave, seed) {
    let h = Math.imul(ix, 374761393)
        ^ Math.imul(iy, 668265263)
        ^ Math.imul(octave + 1, 2147483647)
        ^ Math.imul(seed, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function quintic(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

// Value noise that repeats every `size` texels: each octave's lattice period
// divides the texture size, so the field wraps without a seam.
export function cloudNoiseAt(x, y, { size = 256, octaves = 5, basePeriod = 4, seed = 1 } = {}) {
    let total = 0;
    let amplitude = 1;
    let norm = 0;
    for (let octave = 0; octave < octaves; octave++) {
        const period = basePeriod << octave;
        const cell = size / period;
        const fx = x / cell;
        const fy = y / cell;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = quintic(fx - x0);
        const ty = quintic(fy - y0);
        const wrap = value => ((value % period) + period) % period;
        const xa = wrap(x0);
        const xb = wrap(x0 + 1);
        const ya = wrap(y0);
        const yb = wrap(y0 + 1);
        const top = hashUnit(xa, ya, octave, seed) + (hashUnit(xb, ya, octave, seed) - hashUnit(xa, ya, octave, seed)) * tx;
        const bottom = hashUnit(xa, yb, octave, seed) + (hashUnit(xb, yb, octave, seed) - hashUnit(xa, yb, octave, seed)) * tx;
        total += (top + (bottom - top) * ty) * amplitude;
        norm += amplitude;
        amplitude *= 0.5;
    }
    return total / norm;
}

// One byte per texel, stretched to the full range so an authored coverage
// means the same fraction of sky on every seed.
export function buildTileableCloudNoise({ size = 256, octaves = 5, basePeriod = 4, seed = 1 } = {}) {
    if (!(size >= 8) || !Number.isInteger(Math.log2(size))) {
        throw new Error('cloud noise: size must be a power of two of at least 8');
    }
    if ((basePeriod << (octaves - 1)) > size) {
        throw new Error('cloud noise: too many octaves for the texture size');
    }
    const values = new Float32Array(size * size);
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const value = cloudNoiseAt(x, y, { size, octaves, basePeriod, seed });
            values[y * size + x] = value;
            min = Math.min(min, value);
            max = Math.max(max, value);
        }
    }
    const range = Math.max(1e-6, max - min);
    const data = new Uint8Array(size * size);
    for (let index = 0; index < values.length; index++) {
        data[index] = Math.round(((values[index] - min) / range) * 255);
    }
    return data;
}
