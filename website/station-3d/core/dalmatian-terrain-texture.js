// Builds deterministic, seamless colour and height rasters for dry Dalmatian
// limestone, terra rossa, and sparse sun-bleached ground cover.

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function hash2d(x, y, seed) {
    let value = Math.imul((x | 0) ^ seed, 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16) ^ (y | 0), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967295;
}

function periodicValueNoise(u, v, cells, seed) {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % cells;
    const y1 = (y0 + 1) % cells;
    const tx = smoothstep(0, 1, x - x0);
    const ty = smoothstep(0, 1, y - y0);
    const ix0 = ((x0 % cells) + cells) % cells;
    const iy0 = ((y0 % cells) + cells) % cells;
    const a = hash2d(ix0, iy0, seed);
    const b = hash2d(x1, iy0, seed);
    const c = hash2d(ix0, y1, seed);
    const d = hash2d(x1, y1, seed);
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
}

function mixColor(left, right, amount) {
    return [
        left[0] + (right[0] - left[0]) * amount,
        left[1] + (right[1] - left[1]) * amount,
        left[2] + (right[2] - left[2]) * amount,
    ];
}

export function createDalmatianTerrainRaster(size = 512, seed = 0x5f17a11) {
    const dimension = Math.max(8, Math.floor(Number(size) || 0));
    const color = new Uint8Array(dimension * dimension * 4);
    const height = new Uint8Array(dimension * dimension * 4);
    const limestone = [190, 184, 164];
    const brightStone = [211, 205, 183];
    const redSoil = [145, 105, 73];
    const dryCover = [143, 142, 94];

    for (let y = 0; y < dimension; y++) {
        const v = y / dimension;
        for (let x = 0; x < dimension; x++) {
            const u = x / dimension;
            const broad = periodicValueNoise(u, v, 2, seed + 11);
            const macro = periodicValueNoise(u, v, 4, seed + 29);
            const stoneNoise = periodicValueNoise(u, v, 8, seed + 47);
            const coverNoise = periodicValueNoise(u, v, 16, seed + 71);
            const grain = hash2d(x, y, seed + 101) - 0.5;

            const stoneField = broad * 0.32 + macro * 0.43 + stoneNoise * 0.25;
            const stoneWeight = smoothstep(0.47, 0.69, stoneField);
            const coverWeight = (1 - stoneWeight)
                * smoothstep(0.55, 0.78, coverNoise * 0.7 + macro * 0.3)
                * 0.62;
            let rgb = mixColor(redSoil, limestone, stoneWeight);
            rgb = mixColor(rgb, dryCover, coverWeight);
            const paleVein = stoneWeight
                * smoothstep(0.72, 0.91, periodicValueNoise(u, v, 32, seed + 131));
            rgb = mixColor(rgb, brightStone, paleVein * 0.45);

            // Thin darker seams suggest fractured limestone without painting
            // a regular brick-like grid across the landscape.
            const fractureNoise = periodicValueNoise(u, v, 32, seed + 173);
            const fracture = stoneWeight * (1 - smoothstep(0.025, 0.065, Math.abs(fractureNoise - 0.5)));
            const shade = grain * 15 - fracture * 23;
            const offset = (y * dimension + x) * 4;
            color[offset] = clamp(Math.round(rgb[0] + shade), 0, 255);
            color[offset + 1] = clamp(Math.round(rgb[1] + shade), 0, 255);
            color[offset + 2] = clamp(Math.round(rgb[2] + shade), 0, 255);
            color[offset + 3] = 255;

            const relief = clamp(0.28 + stoneWeight * 0.46 + paleVein * 0.1
                + coverWeight * 0.08 + grain * 0.08 - fracture * 0.16);
            const reliefByte = Math.round(relief * 255);
            height[offset] = reliefByte;
            height[offset + 1] = reliefByte;
            height[offset + 2] = reliefByte;
            height[offset + 3] = 255;
        }
    }
    return { size: dimension, color, height };
}
