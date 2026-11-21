// The shore-formation probe must see what the surface audit cannot: a paved
// shore that ramps into the sea. Fixtures carry the heights measured on
// Split's Riva on 2026-09-16 (sea at -0.738, promenade terrain about -0.05).

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditShoreQuad, auditShoreQuads, SHORE_KIND } from '../core/shore-formation-audit.js';

// Shoreline along x at z = 0, land towards +z.
const quad = { shoreA: [0, 0], shoreB: [4, 0], landA: [0, 4.5], landB: [4, 4.5] };
const seaY = -0.738;
// Before the fix: the collar ramps from the sea up to the terrain over 4.5 m.
const ramp = (x, z) => (z < 4.5 ? seaY + 0.012 + (z / 4.5) * 0.68 : -0.05);
// After the fix: a flat deck at terrain + lift meets the sea with a wall.
const deck = (x, z) => (z < 5.4 ? -0.05 + 0.012 : -0.05);

test('a paved shore that ramps into the sea is a formation fault', () => {
    const before = auditShoreQuad(quad, { seaY, topYAt: ramp, pavedAt: () => true });
    assert.equal(before.kind, SHORE_KIND.RAMPED);
    // One metre inland the 4.5 m ramp is still half a metre below the promenade.
    assert.ok(before.dropM > 0.5 && before.inlandFreeboardM > 0.28, JSON.stringify(before));
    const after = auditShoreQuad(quad, { seaY, topYAt: deck, pavedAt: () => true });
    assert.equal(after.kind, SHORE_KIND.CLEAN);
    assert.ok(Math.abs(after.nearFreeboardM - 0.7) < 1e-9);
    assert.ok(Math.abs(after.dropM + 0.012) < 1e-9, 'the deck stands at the promenade grade');
});

test('natural banks, low paving and unsampled shores are reported, never counted as faults', () => {
    assert.equal(auditShoreQuad(quad, { seaY, topYAt: ramp, pavedAt: () => false }).kind, SHORE_KIND.NATURAL);
    // Paved but only 0.2 m above the sea: no quay is expected there.
    assert.equal(auditShoreQuad(quad, { seaY, topYAt: () => seaY + 0.2, pavedAt: () => true }).kind, SHORE_KIND.LOW);
    assert.equal(auditShoreQuad(quad, { seaY, topYAt: (x, z) => (z > 2 ? -0.05 : null), pavedAt: () => true }).kind,
        SHORE_KIND.UNSAMPLED);
    // Missing sea level or a degenerate quad is not a sample at all.
    assert.equal(auditShoreQuad(quad, { seaY: null, topYAt: deck, pavedAt: () => true }), null);
    assert.equal(auditShoreQuad({ shoreA: [0, 0], shoreB: [4, 0] }, { seaY, topYAt: deck, pavedAt: () => true }), null);
});

test('the report counts every kind and lists only the ramped shores with their positions', () => {
    const quads = [quad, { ...quad, shoreA: [4, 0], shoreB: [8, 0], landA: [4, 4.5], landB: [8, 4.5] }];
    const report = auditShoreQuads(quads, { seaY, topYAt: (x, z) => (x < 4 ? ramp(x, z) : deck(x, z)), pavedAt: () => true });
    assert.equal(report.quadCount, 2);
    assert.deepEqual(report.byKind, { [SHORE_KIND.RAMPED]: 1, [SHORE_KIND.CLEAN]: 1 });
    assert.equal(report.ramped.length, 1);
    assert.deepEqual([report.ramped[0].x, report.ramped[0].z], [2, 0]);
    assert.equal(auditShoreQuads([], { seaY, topYAt: deck, pavedAt: () => true }).quadCount, 0);
});
