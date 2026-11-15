// Procedural farmland patchwork for the default ground: instead of one flat green,
// the terrain reads as a quilt of long narrow fields, each with its own crop colour,
// crop rows and a darker hedgerow-ish rim. Pure — no DOM, no three.js, no canvas — so the pattern
// maths is unit-testable headless; the caller wraps the returned RGBA bytes in a
// texture and samples it in world space (see world/urban-ground-surface.js).
//
// The pattern is PERIODIC by construction: strip and segment counts are integers
// over the tile and the domain warp uses wrapped lattice noise, so the raster tiles
// seamlessly and no seam line appears every tileM metres. Fields are bands rather
// than rotated rectangles precisely because rotation cannot be made to wrap.

// Lowland farmland covers as absolute sRGB colours, plus how strongly each shows
// crop rows (0 = none, 1 = deep furrows). They were multipliers on the dark grass
// texture, which can only shade green: a brown or straw field needs several times
// the grass's red, so every field read as the same flat green (2026-11-15). The
// shader keeps the grass texture's grain as relative detail on top of these.
// Muted on purpose — a backdrop, not coloured tiles — but distinct crops.
export const FIELD_COVERS = Object.freeze([
    Object.freeze({ name: 'winter cereal', rgb: [82, 112, 50], rows: 0.45 }),
    Object.freeze({ name: 'young cereal', rgb: [92, 120, 58], rows: 0.4 }),
    Object.freeze({ name: 'pasture', rgb: [62, 96, 44], rows: 0 }),
    Object.freeze({ name: 'meadow', rgb: [72, 100, 50], rows: 0 }),
    Object.freeze({ name: 'rapeseed', rgb: [70, 106, 60], rows: 0.35 }),
    Object.freeze({ name: 'maize stubble', rgb: [126, 112, 74], rows: 0.6 }),
    Object.freeze({ name: 'cereal stubble', rgb: [138, 124, 84], rows: 0.5 }),
    Object.freeze({ name: 'dry fallow', rgb: [104, 102, 64], rows: 0 }),
    Object.freeze({ name: 'ploughed', rgb: [88, 70, 52], rows: 0.9 }),
    Object.freeze({ name: 'harrowed', rgb: [110, 90, 66], rows: 0.55 }),
    Object.freeze({ name: 'soy stubble', rgb: [112, 100, 76], rows: 0.5 }),
    Object.freeze({ name: 'pasture', rgb: [58, 90, 42], rows: 0 }),
]);

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
    size: 512,        // 4 m/px over the 2 km tile, so a ~60 m strip keeps its rim
    tileM: 2048,      // world metres the raster spans before repeating
    strips: 32,       // bands across the tile → ~64 m mean field width, like Posavina strips
    segments: 5,      // splits along each band → ~410 m mean field length (long and narrow)
    warpAmount: 0.35, // band waviness, in strip-heights
    warpPeriod: 4,    // lattice period of the warp (must divide evenly for tiling)
    rimStrength: 0.30, // how much darker a field boundary is
    rimWidth: 0.06,   // boundary thickness as a fraction of a cell (~4 m across a strip)
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
              seed) * FIELD_COVERS.length,
    ) % FIELD_COVERS.length;

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

// Full RGBA raster. RGB is the field's sRGB colour darkened toward its boundary;
// A is its crop-row strength (0..255), faded out at the rim so rows stop short of
// the hedge. The caller uploads it as an sRGB texture.
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
            const cover = FIELD_COVERS[sample.tintIndex];

            // Darken toward the boundary: full rim at the edge, none past rimWidth.
            const inside = smoothstep(Math.min(1, sample.edgeDistance / rimWidth));
            const rim = 1 - rimStrength * (1 - inside);

            const i = (y * size + x) * 4;
            color[i] = Math.max(0, Math.min(255, Math.round(cover.rgb[0] * rim)));
            color[i + 1] = Math.max(0, Math.min(255, Math.round(cover.rgb[1] * rim)));
            color[i + 2] = Math.max(0, Math.min(255, Math.round(cover.rgb[2] * rim)));
            color[i + 3] = Math.round(cover.rows * inside * 255);
        }
    }

    return { color, size, tileM: o.tileM, uvPerM: 1 / o.tileM };
}
