// Curb suppression asks "is this piece over a planner trackbed?" once per
// sampled piece, five times over for the raised cross-section, with a ring
// sampled every 2 m. Against a 52 km project's worth of corridor volumes that
// was a full scan each time — the measured 140 ms parking lot.
//
// The index replaces the scan. It may return extra candidates (the caller still
// runs the exact oriented-box test) but it must NEVER return fewer than the scan
// would have matched: a miss paints a kerb straight through a trackbed, costs
// nothing, and looks almost right. Every test here is that one property.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerTrackIndex, plannerTrackAabb } from '../core/planner-track-index.js';

// An axis-aligned volume is the easy case; a rotated one is where an AABB that
// forgets to account for orientation goes wrong.
function volume(centerX, centerZ, halfWidth, halfDepth, headingRad = 0) {
    const c = Math.cos(headingRad), s = Math.sin(headingRad);
    return {
        centerX, centerZ, halfWidth, halfDepth,
        alongX: c, alongZ: s,
        rightX: -s, rightZ: c,
    };
}

// The exact test the callers run, mirrored here so the parity check is against
// real matching rather than against the index's own idea of a match.
function insideExact(v, x, z) {
    const dx = x - v.centerX, dz = z - v.centerZ;
    const right = dx * v.rightX + dz * v.rightZ;
    const along = dx * v.alongX + dz * v.alongZ;
    return Math.abs(right) <= v.halfWidth && Math.abs(along) <= v.halfDepth;
}

test('an empty or absent volume list yields no index at all', () => {
    for (const empty of [[], null, undefined]) {
        assert.equal(createPlannerTrackIndex(empty, { padM: 1 }), null);
    }
});

test('the AABB of a rotated box covers its corners', () => {
    const v = volume(0, 0, 2, 10, Math.PI / 4);
    const box = plannerTrackAabb(v, 0);
    // Corners of the oriented box, in world space.
    for (const [r, a] of [[2, 10], [2, -10], [-2, 10], [-2, -10]]) {
        const x = v.centerX + v.rightX * r + v.alongX * a;
        const z = v.centerZ + v.rightZ * r + v.alongZ * a;
        assert.ok(x >= box.minX - 1e-9 && x <= box.maxX + 1e-9, `corner x ${x} outside ${box.minX}..${box.maxX}`);
        assert.ok(z >= box.minZ - 1e-9 && z <= box.maxZ + 1e-9, `corner z ${z} outside ${box.minZ}..${box.maxZ}`);
    }
});

test('pad grows the box on both axes', () => {
    const tight = plannerTrackAabb(volume(0, 0, 1, 1), 0);
    const padded = plannerTrackAabb(volume(0, 0, 1, 1), 3);
    assert.ok(padded.minX < tight.minX && padded.maxX > tight.maxX);
    assert.ok(padded.minZ < tight.minZ && padded.maxZ > tight.maxZ);
});

test('a point query never misses a volume the full scan would match', () => {
    // The load-bearing property, over a long rotated alignment plus scattered
    // station volumes — the two shapes a real project produces.
    const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(11);
    const volumes = [];
    // A 4 km alignment as ~12 m segments, curving.
    let x = 0, z = 0, heading = 0;
    for (let i = 0; i < 330; i++) {
        heading += (rnd() - 0.5) * 0.08;
        volumes.push(volume(x, z, 4 + rnd(), 6, heading));
        x += Math.cos(heading) * 12;
        z += Math.sin(heading) * 12;
    }
    for (let i = 0; i < 40; i++) {
        volumes.push(volume(rnd() * 3000, rnd() * 900 - 450, 10 + rnd() * 20, 30 + rnd() * 60, rnd() * Math.PI));
    }

    const index = createPlannerTrackIndex(volumes, { padM: 1.8 });
    let checked = 0, matched = 0;
    for (let i = 0; i < 4000; i++) {
        const qx = rnd() * 3400 - 200;
        const qz = rnd() * 1100 - 550;
        const expected = volumes.filter(v => insideExact(v, qx, qz));
        const candidates = index.candidatesAt(qx, qz);
        for (const v of expected) {
            assert.ok(candidates.includes(v),
                `index missed a matching volume at ${qx.toFixed(1)},${qz.toFixed(1)}`);
        }
        checked += 1;
        matched += expected.length;
    }
    assert.equal(checked, 4000);
    // A sweep that never matched anything would pass while proving nothing.
    assert.ok(matched > 200, `expected real matches in the sweep, got ${matched}`);
});

test('an edge query never misses a volume whose padded box the edge overlaps', () => {
    const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(29);
    const volumes = [];
    for (let i = 0; i < 200; i++) {
        volumes.push(volume(rnd() * 1200, rnd() * 600, 3 + rnd() * 4, 6 + rnd() * 10, rnd() * Math.PI));
    }
    const PAD = 1.8;
    const index = createPlannerTrackIndex(volumes, { padM: PAD });

    let overlaps = 0;
    for (let i = 0; i < 2500; i++) {
        const ax = rnd() * 1300 - 50, az = rnd() * 700 - 50;
        const bx = ax + (rnd() - 0.5) * 30, bz = az + (rnd() - 0.5) * 30;
        const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
        const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
        const expected = volumes.filter(v => {
            const b = plannerTrackAabb(v, PAD);
            return maxX >= b.minX && minX <= b.maxX && maxZ >= b.minZ && minZ <= b.maxZ;
        });
        const candidates = index.candidatesInBox(minX, minZ, maxX, maxZ);
        for (const v of expected) {
            assert.ok(candidates.includes(v), `edge query missed a volume near ${ax.toFixed(0)},${az.toFixed(0)}`);
        }
        overlaps += expected.length;
    }
    assert.ok(overlaps > 100, `expected real overlaps, got ${overlaps}`);
});

test('the index actually narrows — otherwise it is a scan with extra steps', () => {
    const volumes = [];
    let x = 0;
    for (let i = 0; i < 2000; i++) { volumes.push(volume(x, 0, 4, 6)); x += 12; }
    const index = createPlannerTrackIndex(volumes, { padM: 1.8 });
    const candidates = index.candidatesAt(12000, 0);
    assert.ok(candidates.length < 20,
        `expected a handful of candidates from 2000 volumes, got ${candidates.length}`);
    assert.ok(candidates.length > 0, 'and it must still find the ones that are there');
    assert.equal(index.stats().items, 2000);
});

test('a volume with no usable bounds is still returned by every query', () => {
    // bounds-grid parks unusable items in an always-checked list. If that ever
    // stopped happening, a NaN-centred volume would silently vanish.
    const broken = volume(Number.NaN, 0, 4, 6);
    const fine = volume(500, 0, 4, 6);
    const index = createPlannerTrackIndex([broken, fine], { padM: 1.8 });
    assert.ok(index.candidatesAt(-9999, -9999).includes(broken));
});
