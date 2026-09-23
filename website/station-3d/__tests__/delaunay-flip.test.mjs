// Delaunay edge flipping: needle fans become well-shaped triangles, while the point set, the
// covered area, the boundary edges and the winding are unchanged; refinement of an earcut
// road strip then makes well-shaped triangles instead of slivers.
import test from 'node:test';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { delaunayFlip } from '../core/delaunay-flip.js';
import { refineTriangulatedSurface } from '../core/road-formation.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';

// A 60 m × 6 m strip with boundary points every 6 m, triangulated as one fan from a corner:
// the shape earcut produces on long buffered road polygons.
function stripFan() {
    const points = [];
    for (let x = 0; x <= 60; x += 6) points.push({ x, z: 0 });
    for (let x = 60; x >= 0; x -= 6) points.push({ x, z: 6 });
    const triangles = [];
    for (let i = 1; i + 1 < points.length; i++) triangles.push([0, i, i + 1]);
    return { points, triangles };
}

const signedArea = (p, [a, b, c]) => ((p[b].x - p[a].x) * (p[c].z - p[a].z) - (p[b].z - p[a].z) * (p[c].x - p[a].x)) / 2;
const edges = (p, t) => [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].map(([a, b]) => Math.hypot(p[a].x - p[b].x, p[a].z - p[b].z));
// Triangle height over its longest edge: under 5 cm is a sliver.
const thinness = (p, t) => (2 * Math.abs(signedArea(p, t))) / Math.max(...edges(p, t));
function boundaryEdges(triangles) {
    const count = new Map();
    for (const t of triangles) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = Math.min(a, b) + ':' + Math.max(a, b); count.set(k, (count.get(k) || 0) + 1);
    }
    return [...count].filter(([, n]) => n === 1).map(([k]) => k).sort();
}

test('flipping a needle fan keeps points, area, boundary and winding, and removes the needles', () => {
    const { points, triangles } = stripFan();
    const before = triangles.map(t => [...t]);
    const worstBefore = Math.min(...before.map(t => thinness(points, t)));
    const flips = delaunayFlip(points, triangles);
    assert.ok(flips > 0);
    assert.equal(triangles.length, before.length);
    const area = ts => ts.reduce((s, t) => s + signedArea(points, t), 0);
    assert.ok(Math.abs(area(triangles) - area(before)) < 1e-9, 'covered area unchanged');
    assert.ok(triangles.every(t => Math.sign(signedArea(points, t)) === Math.sign(area(before))), 'winding kept');
    assert.deepEqual(boundaryEdges(triangles), boundaryEdges(before), 'boundary edges never flip');
    const worstAfter = Math.min(...triangles.map(t => thinness(points, t)));
    assert.ok(worstBefore < 0.7 && worstAfter >= 4, `worst height ${worstBefore.toFixed(2)} → ${worstAfter.toFixed(2)} m`);
});

test('refining an earcut road strip splits well-shaped triangles, not slivers', () => {
    // Earcut (three's ShapeUtils, as roads use) on the strip outline. Without the flip, refinement
    // to 1 m edges made 33,664 triangles (30,080 slivers) for the exact outline and 7,808 (4,096)
    // with the boundary jittered by up to 2 cm, as near-collinear densified road rings are.
    for (const jitter of [0, 0.02]) {
        const { points } = stripFan();
        let k = 0;
        for (const p of points) p.z += jitter * (((k++ * 7919) % 13) - 6) / 6;
        const triangles = THREE.ShapeUtils.triangulateShape(points.map(p => new THREE.Vector2(p.x, p.z)), []);
        const refined = refineTriangulatedSurface(points, triangles, 1, Infinity);
        const slivers = refined.triangles.filter(t => thinness(refined.points, t) < 0.05).length;
        assert.ok(refined.triangles.length <= 3000, `jitter ${jitter}: ${refined.triangles.length} triangles`);
        assert.equal(slivers, 0, `jitter ${jitter}: slivers`);
        const longest = Math.max(...refined.triangles.flatMap(t => edges(refined.points, t)));
        assert.ok(longest <= 1 + 1e-9, 'the refinement edge bound still holds');
    }
});

test('an already Delaunay grid is left alone, including cocircular squares', () => {
    const points = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }];
    const triangles = [[0, 1, 2], [0, 2, 3]];
    assert.equal(delaunayFlip(points, triangles), 0);
    assert.deepEqual(triangles, [[0, 1, 2], [0, 2, 3]]);
});

// Road-like buffered polylines (random turns, 20 m or 4 m collinear densification, some
// self-touching), triangulated by earcut and refined. A flip on near-collinear Float32 points once
// folded two triangles onto one side of an edge, which the receiver topology check rejects.
test('refined random road rings stay a consistently joined receiver surface', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 150; trial++) {
        const n = 3 + Math.floor(rnd() * 6), hw = 2 + rnd() * 6;
        let x = rnd() * 3000 - 1500, z = rnd() * 3000 - 1500, h = rnd() * 6.28;
        const line = [{ x, z }];
        for (let i = 0; i < n; i++) { h += (rnd() - 0.5) * 1.2; const L = 5 + rnd() * 80; x += Math.cos(h) * L; z += Math.sin(h) * L; line.push({ x, z }); }
        const left = [], right = [];
        line.forEach((point, i) => {
            const p = line[Math.max(0, i - 1)], q = line[Math.min(line.length - 1, i + 1)];
            const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
            left.push({ x: point.x - dz / l * hw, z: point.z + dx / l * hw });
            right.push({ x: point.x + dz / l * hw, z: point.z - dx / l * hw });
        });
        const outline = [...left, ...right.reverse()], ring = [];
        outline.forEach((a, i) => {
            const b = outline[(i + 1) % outline.length], step = rnd() < 0.5 ? 20 : 4;
            const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
            for (let j = 0; j < parts; j++) ring.push({ x: a.x + (b.x - a.x) * j / parts, z: a.z + (b.z - a.z) * j / parts });
        });
        // Seeded exactly as roads seed refinement: ShapeGeometry (which reorients the ring) with
        // Float32 positions.
        const shape = new THREE.Shape();
        ring.forEach((p, i) => (i ? shape.lineTo(p.x, p.z) : shape.moveTo(p.x, p.z)));
        const geometry = new THREE.ShapeGeometry(shape), position = geometry.getAttribute('position');
        const points = Array.from({ length: position.count }, (_, i) => ({ x: position.getX(i), z: position.getY(i) }));
        const index = geometry.index.array, triangles = [];
        for (let i = 0; i < index.length; i += 3) triangles.push([index[i], index[i + 1], index[i + 2]]);
        const refined = refineTriangulatedSurface(points, triangles, 1 + rnd() * 3, 1200);
        const positions = new Float32Array(refined.points.length * 3);
        refined.points.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 2] = p.z; });
        const steps = createReceiverFootprintSteps({ positions, indices: new Uint32Array(refined.triangles.flat()), maxTriangles: 1e6 });
        assert.doesNotThrow(() => { let step = steps.next(); while (!step.done) step = steps.next(); }, `trial ${trial}`);
    }
});
