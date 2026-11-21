// Roof-life layout on new-build flat roofs: program choice, containment (every
// element stays on the roof and off the courtyard), railing marching, the
// jogging-track fallback, and determinism — all pure, all headless.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROOF_POOL_LENGTH_M,
    ROOF_POOL_OUTER_LENGTH_M,
    ROOF_POOL_OUTER_WIDTH_M,
    ROOF_POOL_WIDTH_M,
    ROOF_RAILING_INSET_M,
    ROOF_RAILING_POST_SPACING_M,
    newBuildRoofLayout,
} from '../core/new-build-roof-decor.js';
import { benchSeatFrame } from '../core/pedestrian-bench-behavior.js';
import {
    createRoofActivitySurface,
    roofActivityPointIsSafe,
    roofActivitySegmentIsSafe,
} from '../core/pedestrian-roof-activity.js';
import { EARTH_RADIUS_M, geoToLocal } from '../core/math.js';

const ANCHOR_LAT = 43.75;
const ANCHOR_LON = 15.87;
// The sim's own geodesy (mean radius), so the helper's metres are the layout's.
const M_PER_DEG_LAT = EARTH_RADIUS_M * Math.PI / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(ANCHOR_LAT * Math.PI / 180);

// Closed lon/lat rectangle of w×d metres centred on the anchor (CCW).
function rectRing(w, d, cx = 0, cz = 0) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const toLonLat = (x, z) => [ANCHOR_LON + x / M_PER_DEG_LON, ANCHOR_LAT - z / M_PER_DEG_LAT];
    return [toLonLat(x0, z0), toLonLat(x1, z0), toLonLat(x1, z1), toLonLat(x0, z1), toLonLat(x0, z0)];
}

function localBounds(w, d, cx = 0, cz = 0) {
    return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
}

function assertInside(point, bounds, margin, label) {
    assert.ok(point.x >= bounds.minX + margin && point.x <= bounds.maxX - margin,
        `${label} x ${point.x.toFixed(2)} outside [${bounds.minX + margin}, ${bounds.maxX - margin}]`);
    assert.ok(point.z >= bounds.minZ + margin && point.z <= bounds.maxZ - margin,
        `${label} z ${point.z.toFixed(2)} outside margin`);
}

function allItems(layout) {
    return [
        ...layout.lawns, ...layout.bushes, ...layout.trees,
        ...layout.chairs, ...layout.benches, ...layout.sunshades, ...layout.barbecues,
    ];
}

function pointOverPool(point, pool, extraM = 0) {
    const dx = point.x - pool.x;
    const dz = point.z - pool.z;
    const cos = Math.cos(pool.angle);
    const sin = Math.sin(pool.angle);
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    return Math.abs(localX) <= pool.outerLengthM / 2 + extraM
        && Math.abs(localZ) <= pool.outerWidthM / 2 + extraM;
}

function poolCorners(pool, extraM = 0) {
    const halfLength = pool.outerLengthM / 2 + extraM;
    const halfWidth = pool.outerWidthM / 2 + extraM;
    const cos = Math.cos(pool.angle);
    const sin = Math.sin(pool.angle);
    return [
        [-halfLength, -halfWidth],
        [halfLength, -halfWidth],
        [halfLength, halfWidth],
        [-halfLength, halfWidth],
    ].map(([x, z]) => ({
        x: pool.x + x * cos - z * sin,
        z: pool.z + x * sin + z * cos,
    }));
}

function localRings(rings) {
    return rings.map(ring => ring.map(([lon, lat]) => geoToLocal(lon, lat, ANCHOR_LON, ANCHOR_LAT)));
}

const BIG = [rectRing(40, 24)];        // 960 m², perimeter 128 — every program fits
const MID = [rectRing(18, 12)];        // 216 m² — decorated, but too small for a track

test('tiny roofs and the plain draw stay undecorated', () => {
    assert.equal(newBuildRoofLayout([rectRing(8, 6)], ANCHOR_LAT, ANCHOR_LON, 0), null);
    for (const hash of [8, 9, 18, 19]) {
        assert.equal(newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, hash), null, `hash ${hash}`);
    }
    assert.equal(newBuildRoofLayout([[[15.87, 43.75]]], ANCHOR_LAT, ANCHOR_LON, 0), null);
});

test('the hash deterministically picks terrace, garden and track programs', () => {
    assert.equal(newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 0).program, 'terrace');
    assert.equal(newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 3).program, 'garden');
    assert.equal(newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 6).program, 'track');
    const twice = [0, 1].map(() => newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 3));
    assert.deepEqual(twice[0], twice[1], 'same inputs must lay out identically');
});

test('selected fitting roofs receive one fixed 8 x 4 m recreational pool', () => {
    for (const hash of [1, 4]) {
        const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, hash);
        assert.ok(layout.pool, `hash ${hash} should receive a pool`);
        assert.equal(layout.pool.lengthM, ROOF_POOL_LENGTH_M);
        assert.equal(layout.pool.widthM, ROOF_POOL_WIDTH_M);
        assert.equal(layout.pool.outerLengthM, ROOF_POOL_OUTER_LENGTH_M);
        assert.equal(layout.pool.outerWidthM, ROOF_POOL_OUTER_WIDTH_M);
    }
    assert.equal(newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 6).pool, null,
        'a jogging track and pool are mutually exclusive roof programs');
    const tooNarrow = newBuildRoofLayout([rectRing(10, 7)], ANCHOR_LAT, ANCHOR_LON, 1);
    assert.ok(tooNarrow, 'the roof still receives its ordinary terrace program');
    assert.equal(tooNarrow.pool, null, 'the complete pool footprint does not fit');
});

test('the pool footprint is reserved before every other roof item', () => {
    const radiusOf = (item, kind) => ({
        lawns: Math.hypot(item.w, item.d) / 2,
        bushes: item.r,
        trees: item.h * 0.34,
        chairs: 0.35,
        benches: 1.2,
        sunshades: 1.4,
        barbecues: 0.75,
    })[kind];
    for (const hash of [1, 4]) {
        const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, hash);
        assert.ok(layout.pool);
        for (const kind of [
            'lawns', 'bushes', 'trees', 'chairs', 'benches', 'sunshades', 'barbecues',
        ]) {
            for (const item of layout[kind]) {
                assert.equal(
                    pointOverPool(item, layout.pool, radiusOf(item, kind)),
                    false,
                    `${kind} overlaps the pool at ${item.x.toFixed(1)},${item.z.toFixed(1)}`,
                );
            }
        }
    }
});

test('the railing hugs the roof edge just inside the footprint', () => {
    const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 0);
    const bounds = localBounds(40, 24);
    for (const p of layout.railing.ring) {
        assertInside(p, bounds, ROOF_RAILING_INSET_M * 0.5, 'railing');
        // …but no deeper than about the inset itself.
        const edgeDistance = Math.min(
            p.x - bounds.minX, bounds.maxX - p.x, p.z - bounds.minZ, bounds.maxZ - p.z);
        assert.ok(edgeDistance <= ROOF_RAILING_INSET_M * 1.8, `railing sits ${edgeDistance.toFixed(2)} m in`);
    }
});

test('railing posts march the ring at the configured spacing', () => {
    const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 0);
    const posts = layout.railing.posts;
    const perimeter = 2 * (40 + 24) - 8 * ROOF_RAILING_INSET_M;
    const expected = Math.floor(perimeter / ROOF_RAILING_POST_SPACING_M);
    assert.ok(Math.abs(posts.length - expected) <= 2, `${posts.length} posts vs ~${expected}`);
    for (let i = 1; i < posts.length; i++) {
        const d = Math.hypot(posts[i].x - posts[i - 1].x, posts[i].z - posts[i - 1].z);
        // Chords across corners come in short; nothing may exceed the spacing.
        assert.ok(d <= ROOF_RAILING_POST_SPACING_M + 0.01, `gap ${d.toFixed(2)}`);
    }
});

test('the jogging track ringloops inside the roof and outside its infield', () => {
    const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 6);
    assert.equal(layout.program, 'track');
    assert.ok(layout.track);
    assert.equal(layout.track.outer.length, layout.track.inner.length);
    const bounds = localBounds(40, 24);
    for (let i = 0; i < layout.track.outer.length; i++) {
        const outer = layout.track.outer[i];
        const inner = layout.track.inner[i];
        assertInside(outer, bounds, 0.3, 'track outer');
        // The inner ring sits strictly deeper than its outer partner.
        const outerEdge = Math.min(outer.x - bounds.minX, bounds.maxX - outer.x,
            outer.z - bounds.minZ, bounds.maxZ - outer.z);
        const innerEdge = Math.min(inner.x - bounds.minX, bounds.maxX - inner.x,
            inner.z - bounds.minZ, bounds.maxZ - inner.z);
        assert.ok(innerEdge > outerEdge + 0.5, `band collapsed at vertex ${i}`);
    }
});

test('a mid-size roof falls back from track to garden instead of a degenerate loop', () => {
    const layout = newBuildRoofLayout(MID, ANCHOR_LAT, ANCHOR_LON, 6);
    assert.equal(layout.program, 'garden');
    assert.equal(layout.track, null);
    assert.ok(layout.bushes.length + layout.trees.length + layout.lawns.length > 0);
});

test('terrace and garden furnish the roof and keep everything clear of the edge', () => {
    const bounds = localBounds(40, 24);
    const terrace = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 0);
    assert.ok(terrace.sunshades.length > 0);
    assert.ok(terrace.chairs.length >= terrace.sunshades.length * 2);
    assert.ok(terrace.barbecues.length >= 1);
    assert.equal(terrace.bushes.length + terrace.trees.length, 0);
    const garden = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 3);
    assert.ok(garden.bushes.length > 0);
    assert.ok(garden.trees.length > 0);
    assert.ok(garden.lawns.length > 0);
    assert.equal(garden.sunshades.length + garden.barbecues.length, 0);
    for (const layout of [terrace, garden]) {
        assert.equal(layout.benches.length, 1,
            `${layout.program} must publish one usable roof bench without over-furnishing it`);
        for (const item of allItems(layout)) assertInside(item, bounds, 0.5, layout.program);
    }
});

test('the paired chairs under each parasol face inward toward its pole', () => {
    const terrace = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, 0);
    for (const [index, shade] of terrace.sunshades.entries()) {
        for (const chair of terrace.chairs.slice(index * 2, index * 2 + 2)) {
            const dx = shade.x - chair.x;
            const dz = shade.z - chair.z;
            const distance = Math.hypot(dx, dz);
            const facingDot = Math.cos(chair.angle) * (dx / distance)
                + Math.sin(chair.angle) * (dz / distance);
            assert.ok(facingDot > 0.99,
                `chair at parasol ${index} faces away from its table/pole (${facingDot})`);
        }
    }
});

test('every rendered roof bench has a safe seat and approach on its roof surface', () => {
    for (const hash of [0, 1, 3, 4, 6]) {
        const layout = newBuildRoofLayout(BIG, ANCHOR_LAT, ANCHOR_LON, hash);
        const surface = createRoofActivitySurface({
            id: `new-build:test:${hash}`,
            rings: localRings(BIG),
            floorY: 15,
            obstacles: layout.pool ? [layout.pool] : [],
        });
        assert.ok(surface);
        if (layout.pool) {
            assert.equal(roofActivityPointIsSafe(
                surface,
                layout.pool.x,
                layout.pool.z,
            ), false, 'pool water is not pedestrian roof space');
        }
        assert.ok(layout.benches.length > 0);
        for (const [index, bench] of layout.benches.entries()) {
            const frame = benchSeatFrame({
                id: `bench:${hash}:${index}`,
                x: bench.x,
                z: bench.z,
                seatY: 15.5,
                yaw: bench.angle,
                surfaceId: surface.id,
            });
            assert.equal(roofActivityPointIsSafe(surface, frame.x, frame.z), true);
            assert.equal(roofActivityPointIsSafe(surface, frame.approachX, frame.approachZ), true);
            assert.equal(roofActivitySegmentIsSafe(surface, frame, {
                x: frame.approachX,
                z: frame.approachZ,
            }), true);
        }
    }
});

test('a courtyard block keeps every element on the roof band, not over the court', () => {
    // 44×30 outer with a 24×12 courtyard: an 8–10 m wide ring of roof.
    const outer = rectRing(44, 30);
    const hole = rectRing(24, 12).slice().reverse();   // opposite winding, as GeoJSON holes are
    const court = localBounds(24, 12);
    for (const hash of [3, 4]) {
        const layout = newBuildRoofLayout([outer, hole], ANCHOR_LAT, ANCHOR_LON, hash);
        assert.ok(layout, 'a courtyard block this size must still decorate');
        for (const item of allItems(layout)) {
            const inCourt = item.x > court.minX && item.x < court.maxX
                && item.z > court.minZ && item.z < court.maxZ;
            assert.ok(!inCourt, `${layout.program} item over the courtyard at ${item.x.toFixed(1)},${item.z.toFixed(1)}`);
        }
        for (const corner of layout.pool
            ? poolCorners(layout.pool, layout.pool.clearanceM)
            : []) {
            const inCourt = corner.x > court.minX && corner.x < court.maxX
                && corner.z > court.minZ && corner.z < court.maxZ;
            assert.equal(inCourt, false, 'pool safety footprint overlaps the courtyard');
        }
    }
});

test('local frame agrees with the roof cap: geoToLocal round-trips the ring', () => {
    const ring = rectRing(40, 24);
    const p = geoToLocal(ring[1][0], ring[1][1], ANCHOR_LON, ANCHOR_LAT);
    assert.ok(Math.abs(p.x - 20) < 0.01 && Math.abs(p.z - (-12)) < 0.01);
});
