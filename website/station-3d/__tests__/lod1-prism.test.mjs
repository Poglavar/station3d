// Headless unit tests for the cheap prism builder that replaced ExtrudeGeometry.
// The invariants that matter: the roof triangulation actually covers the footprint
// (no gaps/overlaps → correct area), it survives concave shapes and either winding,
// and every prism vertex sits at either the ground or the eave. Run: npm run test:unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    signedArea, triangulate, buildPrism, buildBuildingPrisms,
} from '../world/lod1-geometry.js';

const P = (arr) => arr.map(([x, z]) => ({ x, z }));

function triArea(pts, tris) {
    let a = 0;
    for (const [i, j, k] of tris) {
        a += Math.abs((pts[j].x - pts[i].x) * (pts[k].z - pts[i].z)
                    - (pts[k].x - pts[i].x) * (pts[j].z - pts[i].z)) / 2;
    }
    return a;
}

test('signedArea encodes winding and magnitude', () => {
    const ccw = P([[0, 0], [10, 0], [10, 10], [0, 10]]);
    assert.equal(signedArea(ccw), 100);
    const cw = P([[0, 0], [0, 10], [10, 10], [10, 0]]);
    assert.equal(signedArea(cw), -100);
});

test('triangulate covers a convex square exactly', () => {
    const sq = P([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const tris = triangulate(sq);
    assert.equal(tris.length, 2);                       // n-2 triangles
    assert.ok(Math.abs(triArea(sq, tris) - 100) < 1e-6);
});

test('triangulate covers a concave L exactly, and is winding-independent', () => {
    const L = [[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]];
    const ccw = P(L);
    const trisCcw = triangulate(ccw);
    assert.equal(trisCcw.length, L.length - 2);         // 4 triangles
    const expected = 20 * 6 + 6 * 14;                    // = 204
    assert.ok(Math.abs(triArea(ccw, trisCcw) - expected) < 1e-6, `ccw area ${triArea(ccw, trisCcw)}`);

    const cw = P([...L].reverse());
    const trisCw = triangulate(cw);
    assert.ok(Math.abs(triArea(cw, trisCw) - expected) < 1e-6, `cw area ${triArea(cw, trisCw)}`);
});

test('triangulate handles a bare triangle', () => {
    const tri = P([[0, 0], [4, 0], [0, 3]]);
    assert.deepEqual(triangulate(tri).length, 1);
});

test('buildPrism: square 10x10 h=8 has the expected structure', () => {
    const sq = P([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const { positions, indices } = buildPrism(sq, 8);
    // 4 footprint points → 8 vertices (bottom ring + top ring).
    assert.equal(positions.length / 3, 8);
    // Walls: 4 edges × 2 triangles + roof: 2 triangles = 6 triangles × 3 = 18 indices.
    assert.equal(indices.length, (4 * 2 + 2) * 3);
    // Every vertex y is either the ground (0) or the eave (8).
    for (let v = 0; v < positions.length; v += 3) {
        const y = positions[v + 1];
        assert.ok(y === 0 || y === 8, `stray y=${y}`);
    }
    // Bottom ring at y=0, top ring at y=8.
    assert.equal(positions[1], 0);
    assert.equal(positions[4 * 3 + 1], 8);
});

test('buildPrism strips the GeoJSON closing duplicate', () => {
    const open = P([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const closed = P([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    assert.equal(buildPrism(open, 5).positions.length, buildPrism(closed, 5).positions.length);
});

test('buildPrism merges into a shared accumulator', () => {
    const sq = P([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const acc = { positions: [], indices: [] };
    buildPrism(sq, 5, acc);
    const afterFirst = acc.positions.length;
    buildPrism(sq, 5, acc);
    assert.equal(acc.positions.length, afterFirst * 2);
    // Second building's indices must reference its own vertices, not the first's.
    assert.ok(Math.max(...acc.indices) === acc.positions.length / 3 - 1);
});

test('buildBuildingPrisms handles Polygon and MultiPolygon; null on junk', () => {
    const poly = { type: 'Polygon', coordinates: [[[15.9772, 45.8131], [15.9782, 45.8131], [15.9782, 45.8141], [15.9772, 45.8141]]] };
    const one = buildBuildingPrisms(poly, 6, 15.9772, 45.8131);
    assert.ok(one.positions instanceof Float32Array && one.indices instanceof Uint32Array);
    assert.ok(one.positions.length > 0);

    const multi = { type: 'MultiPolygon', coordinates: [poly.coordinates, poly.coordinates] };
    const two = buildBuildingPrisms(multi, 6, 15.9772, 45.8131);
    assert.equal(two.positions.length, one.positions.length * 2);

    assert.equal(buildBuildingPrisms({ type: 'Point', coordinates: [0, 0] }, 6, 0, 0), null);
});

// WHICH WAY THE FACES POINT. The tests above check that the cap COVERS the
// polygon (right area, no gaps) and that triangulate survives either winding —
// and every one of them passed while the entire LOD1 horizon rendered
// inside-out. Coverage is not orientation: a prism built with reversed winding
// has exactly the same area and exactly the same triangle count.
//
// The far material is FrontSide, so orientation is the whole ballgame. Wrong
// winding culls the near walls (you see straight through the building, and see
// the far walls from behind — reads as "only 2 of the 4 sides are drawn") and
// points the roof cap at the ground, so there is no roof.
//
// Real data made this universal, not occasional: 600 of 600 footprints in a
// centre tile came back with positive signed area, which is the inward one in
// this frame, because geoToLocal negates latitude and flips the usual GeoJSON
// right-hand rule.

// True when stepping off the face along its own normal leaves the footprint.
// Deliberately not an "away from the centroid" test: that is wrong for concave
// shapes, whose centroid can sit outside the polygon.
function pointInRing(px, pz, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
        if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
}

function faceOrientations(ring, height = 20) {
    const { positions, indices } = buildPrism(ring, height);
    const V = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    ];
    const r = { wallsOutward: 0, wallsInward: 0, roofUp: 0, roofDown: 0 };
    for (let t = 0; t < indices.length; t += 3) {
        const a = V(indices[t]), b = V(indices[t + 1]), c = V(indices[t + 2]);
        const n = cross(sub(b, a), sub(c, a));
        if (Math.abs(n[0]) < 1e-9 && Math.abs(n[2]) < 1e-9) {
            n[1] > 0 ? r.roofUp++ : r.roofDown++;
            continue;
        }
        const len = Math.hypot(n[0], n[2]);
        const mx = (a[0] + b[0] + c[0]) / 3 + (n[0] / len) * 0.01;
        const mz = (a[2] + b[2] + c[2]) / 3 + (n[2] / len) * 0.01;
        pointInRing(mx, mz, ring) ? r.wallsInward++ : r.wallsOutward++;
    }
    return r;
}

test('every prism face points OUT, whichever way the footprint is wound', () => {
    const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    // Positive signed area — what all 600 real footprints in a tile look like,
    // and the case that was broken.
    const positive = faceOrientations(square);
    assert.equal(positive.wallsInward, 0, 'no wall may face inward');
    assert.equal(positive.roofDown, 0, 'the roof may not face the ground');
    assert.ok(positive.wallsOutward >= 8 && positive.roofUp >= 2);

    // The other winding must build the identical solid, not the inverse of it.
    const negative = faceOrientations([...square].reverse());
    assert.deepEqual(negative, positive, 'winding must not change what is drawn');
});

test('a concave footprint is solid too', () => {
    // An L cannot be checked against its centroid — that point is outside the
    // polygon — so this is where a lazier orientation test would go green on a
    // broken prism.
    const L = [
        { x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 6 },
        { x: 8, z: 6 }, { x: 8, z: 16 }, { x: 0, z: 16 },
    ];
    for (const ring of [L, [...L].reverse()]) {
        const r = faceOrientations(ring);
        assert.equal(r.wallsInward, 0, 'no wall may face inward');
        assert.equal(r.roofDown, 0, 'the roof may not face the ground');
        assert.equal(r.wallsOutward, 12, 'six edges, two triangles each');
        assert.equal(r.roofUp, 4, 'six-vertex polygon caps with four triangles');
    }
});
