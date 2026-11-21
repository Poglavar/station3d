// Verifies the farmland patchwork pattern: that it actually partitions the tile into
// many elongated fields, that boundaries are darker than field interiors, and that the
// pattern tiles seamlessly (no seam line every tileM metres).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFieldPatchworkRaster,
    fieldAt,
    FIELD_PATCHWORK_DEFAULTS,
} from '../core/field-patchwork-texture.js';

test('partitions the tile into many distinct fields', () => {
    const seen = new Set();
    for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) {
            const { band, segment } = fieldAt(x / 200, y / 200);
            seen.add(`${band}:${segment}`);
        }
    }
    // strips × segments, give or take the warp pushing bands past the tile edge.
    const expected = FIELD_PATCHWORK_DEFAULTS.strips * FIELD_PATCHWORK_DEFAULTS.segments;
    assert.ok(seen.size >= expected, `expected >= ${expected} fields, got ${seen.size}`);
    assert.ok(seen.size < expected * 2, `field count ran away: ${seen.size}`);
});

test('fields are elongated, not square', () => {
    // Mean field length along the band must exceed its depth across the band,
    // otherwise these are patches rather than fields.
    const depthM = FIELD_PATCHWORK_DEFAULTS.tileM / FIELD_PATCHWORK_DEFAULTS.strips;
    const lengthM = FIELD_PATCHWORK_DEFAULTS.tileM / FIELD_PATCHWORK_DEFAULTS.segments;
    assert.ok(lengthM > depthM * 1.5, `expected elongated fields, got ${lengthM}m x ${depthM}m`);
});

test('field boundaries are darker than field interiors', () => {
    const { color, size } = createFieldPatchworkRaster({ size: 128 });
    let rimSum = 0, rimCount = 0, coreSum = 0, coreCount = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const { edgeDistance } = fieldAt(x / size, y / size, { size: 128 });
            const i = (y * size + x) * 4;
            const luminance = (color[i] + color[i + 1] + color[i + 2]) / 3;
            if (edgeDistance < 0.01) { rimSum += luminance; rimCount++; }
            else if (edgeDistance > 0.2) { coreSum += luminance; coreCount++; }
        }
    }
    assert.ok(rimCount > 0 && coreCount > 0, 'expected both rim and interior samples');
    const rim = rimSum / rimCount;
    const core = coreSum / coreCount;
    assert.ok(rim < core - 5, `expected darker boundaries, got rim=${rim.toFixed(1)} core=${core.toFixed(1)}`);
});

test('tiles seamlessly — one tile later the same field, cover and edge distance', () => {
    // The raster samples fieldAt at x/size, so it wraps exactly when fieldAt repeats with
    // period 1 in u and v: the same cover and the same distance to the field's edge (the
    // raw band and segment numbers keep counting past the edge; their wrapped values match).
    const { strips, segments } = FIELD_PATCHWORK_DEFAULTS;
    const wrap = (n, m) => ((n % m) + m) % m;
    for (let i = 0; i < 2000; i++) {
        const u = ((i * 7919) % 2000) / 2000, v = ((i * 104729) % 2000) / 2000;
        const here = fieldAt(u, v);
        for (const there of [fieldAt(u + 1, v), fieldAt(u, v + 1), fieldAt(u - 1, v - 1)]) {
            assert.equal(there.tintIndex, here.tintIndex);
            assert.ok(Math.abs(there.edgeDistance - here.edgeDistance) < 1e-9);
            assert.equal(wrap(there.band, strips), wrap(here.band, strips));
            assert.equal(wrap(there.segment, segments), wrap(here.segment, segments));
        }
    }
});

test('is deterministic per seed and varies between seeds', () => {
    const a = createFieldPatchworkRaster({ size: 64 });
    const b = createFieldPatchworkRaster({ size: 64 });
    const c = createFieldPatchworkRaster({ size: 64, seed: 999 });
    assert.deepEqual(a.color, b.color);
    assert.notDeepEqual(a.color, c.color);
    assert.equal(a.color.length, 64 * 64 * 4);
    assert.equal(a.uvPerM, 1 / FIELD_PATCHWORK_DEFAULTS.tileM);
});

test('default raster stays small enough for synchronous startup generation', () => {
    // 4 m/px over the 2 km tile, so a ~60 m strip keeps its rim (8c655b7).
    assert.equal(FIELD_PATCHWORK_DEFAULTS.size, 512);
    const raster = createFieldPatchworkRaster();
    assert.equal(raster.color.length, 512 * 512 * 4);
});
