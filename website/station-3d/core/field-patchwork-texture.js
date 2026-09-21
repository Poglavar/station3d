// Procedural farmland patchwork for the default ground: instead of one flat green,
// the terrain reads as a quilt of elongated fields, each with its own crop tint and
// a darker hedgerow-ish rim. Pure — no DOM, no three.js, no canvas — so the pattern
// maths is unit-testable headless; the caller wraps the returned RGBA bytes in a
// texture and samples it in world space (see world/urban-ground-surface.js).
//
// The pattern is PERIODIC by construction: strip and segment counts are integers
// over the tile and the domain warp uses wrapped lattice noise, so the raster tiles
// seamlessly and no seam line appears every tileM metres. Fields are bands rather
// than rotated rectangles precisely because rotation cannot be made to wrap.

// Muted crop/pasture greens plus a few fallow browns — deliberately low contrast,
// because the ground is a backdrop: enough variety to break the flat wash, not
// enough to read as coloured tiles. Values are multipliers on the grass texture.
const FIELD_TINTS = [
    [0.86, 1.00, 0.78], // young cereal
    [0.94, 1.02, 0.82],
    [0.78, 0.95, 0.70], // deeper pasture
    [1.02, 1.00, 0.86],
    [0.88, 0.92, 0.72],
    [1.06, 0.98, 0.80], // dry grass
    [0.72, 0.88, 0.68],
    [0.98, 0.94, 0.76],
    [1.10, 1.02, 0.88], // stubble
    [0.82, 0.98, 0.74],
    [0.92, 0.86, 0.68], // ploughed / fallow, browner
    [1.00, 0.90, 0.72],
];

// 2D integer hash → [0,1). Cheap, decorrelated enough for tint/size jitter.
function hash2(ix, iy, seed) {
    let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 2147483647;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
}

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

// Value noise on a wrapped lattice: sampling at u+period is identical to u, which
// is what keeps the whole raster tileable after domain warping.
function periodicNoise(u, v, period, seed) {
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = smoothstep(u - x0);
    const fy = smoothstep(v - y0);
    const wrap = (n) => ((n % period) + period) % period;
    const a = hash2(wrap(x0), wrap(y0), seed);
    const b = hash2(wrap(x0 + 1), wrap(y0), seed);
    const c = hash2(wrap(x0), wrap(y0 + 1), seed);
    const d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export const FIELD_PATCHWORK_DEFAULTS = Object.freeze({
    size: 256,        // 8 m/px over the 2 km tile; ample for 100 m-scale fields
    tileM: 2048,      // world metres the raster spans before repeating
    strips: 14,       // bands across the tile → ~146 m mean field depth
    segments: 7,      // splits along each band → ~293 m mean field length (elongated)
    warpAmount: 0.35, // band waviness, in strip-heights
    warpPeriod: 4,    // lattice period of the warp (must divide evenly for tiling)
    rimStrength: 0.30, // how much darker a field boundary is
    rimWidth: 0.055,  // boundary thickness as a fraction of a cell
    seed: 20260726,
});

// Which field a normalised tile coordinate belongs to, plus how close it is to that
// field's boundary. Exported for tests and for any caller that needs the pattern
// without a raster. `u`/`v` are in [0,1) over the tile.
function fieldAtResolved(u, v, o, result) {
    const { strips, segments, warpAmount, warpPeriod, seed } = o;

    // Warp the band coordinate so field edges meander like real parcel boundaries.
    const warp = periodicNoise(u * warpPeriod, v * warpPeriod, warpPeriod, seed) - 0.5;
    const bandF = v * strips + warp * warpAmount;
    const band = Math.floor(bandF);
    const bandFrac = bandF - band;
    // Wrapped band index: at the tile's top edge band is 0 and at the bottom it is
    // `strips`, so anything hashed from the RAW index differs across the seam and
    // the pattern fails to tile. Everything hashed below uses the wrapped index.
    const bandWrapped = ((band % strips) + strips) % strips;

    // Each band is split along its length; the split offset is per-band so
    // boundaries do not line up into a visible global grid.
    const along = u * segments + hash2(bandWrapped, 0, seed + 17);
    const segment = Math.floor(along);
    const segFrac = along - segment;

    // Distance to the nearest edge of this cell, in cell fractions.
    const edge = Math.min(
        Math.min(bandFrac, 1 - bandFrac),
        Math.min(segFrac, 1 - segFrac),
    );

    const tintIndex = Math.floor(
        hash2(bandWrapped,
              ((segment % segments) + segments) % segments,
              seed) * FIELD_TINTS.length,
    ) % FIELD_TINTS.length;

    const sample = result || {};
    sample.band = band;
    sample.segment = segment;
    sample.tintIndex = tintIndex;
    sample.edgeDistance = edge;
    return sample;
}

export function fieldAt(u, v, options = {}) {
    return fieldAtResolved(u, v, { ...FIELD_PATCHWORK_DEFAULTS, ...options });
}

// Full RGBA raster. RGB carries the per-field tint (a multiplier around 1.0 encoded
// as 0..255 over the 0..2 range) darkened toward field boundaries; A is unused and
// left at 255 so the result drops straight into an RGBA texture.
export function createFieldPatchworkRaster(options = {}) {
    const o = { ...FIELD_PATCHWORK_DEFAULTS, ...options };
    const { size, rimStrength, rimWidth } = o;
    const color = new Uint8Array(size * size * 4);
    // Reuse one sample object. The original implementation allocated both a
    // merged options object and a result object for every pixel (524k objects
    // for the default raster), turning this one-time texture into a long startup
    // task on the browser main thread.
    const sample = {};

    for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
            const u = x / size;
            fieldAtResolved(u, v, o, sample);
            const tint = FIELD_TINTS[sample.tintIndex];

            // Darken toward the boundary: full rim at the edge, none past rimWidth.
            const rim = 1 - rimStrength
                * (1 - smoothstep(Math.min(1, sample.edgeDistance / rimWidth)));

            const i = (y * size + x) * 4;
            // Encode a 0..2 multiplier into a byte, so 1.0 (neutral) is 127.
            color[i] = Math.max(0, Math.min(255, Math.round((tint[0] * rim) * 127.5)));
            color[i + 1] = Math.max(0, Math.min(255, Math.round((tint[1] * rim) * 127.5)));
            color[i + 2] = Math.max(0, Math.min(255, Math.round((tint[2] * rim) * 127.5)));
            color[i + 3] = 255;
        }
    }

    return { color, size, tileM: o.tileM, uvPerM: 1 / o.tileM };
}
