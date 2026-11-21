// Headless unit tests for logical facade-surface grouping — the plane
// clustering that decides whether a wall earns one window grid or shatters
// into strips too narrow to paint. Run: npm run test:unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLogicalFacadeSurfaces,
    buildLogicalFacadeSurfacesCooperative,
    prepareFacadeCoverageIndexCooperative,
    rectangleFullyCoveredBySurface,
} from '../world/facade-surfaces.js';

// A vertical wall strip x∈[x0,x1], height 10, at z = slope·x + offset,
// as two triangles.
function strip(x0, x1, slope = 0, offset = 0) {
    const z = (x) => slope * x + offset;
    const a = [x0, 0, z(x0)], b = [x1, 0, z(x1)];
    const c = [x1, 10, z(x1)], d = [x0, 10, z(x0)];
    return [[a, b, c], [a, c, d]];
}

test('tilted seed strip no longer shatters a long flat wall (running refit)', () => {
    // Strip 0 is planar but tilted 0.004 rad — inside the normal tolerance,
    // yet its seed plane drifts 0.16 m by x=40, past the 0.08 m fit
    // tolerance. With the running refit the flat strips pull the group
    // plane straight and the whole wall stays ONE surface.
    const triangles = [
        ...strip(0, 5, -0.004),
        ...strip(5, 10), ...strip(10, 15), ...strip(15, 20), ...strip(20, 25),
        ...strip(25, 30), ...strip(30, 35), ...strip(35, 40),
    ];
    const surfaces = buildLogicalFacadeSurfaces(triangles);
    assert.equal(surfaces.length, 1, `expected one surface, got ${surfaces.length}`);
    assert.ok(surfaces[0].maxU - surfaces[0].minU > 39, 'surface should span the whole wall');
});

test('genuinely offset parallel walls still stay separate', () => {
    const triangles = [...strip(0, 10, 0, 0), ...strip(0, 10, 0, 1.0)];
    const surfaces = buildLogicalFacadeSurfaces(triangles);
    assert.equal(surfaces.length, 2);
});

test('twisted flat-looking wall (normals ~1° apart) groups into one surface', () => {
    // A ruled surface that reads as one flat wall: z twists bilinearly with
    // x and y, so each triangle's normal tilts by up to ~1.2° — the 62715
    // case. Plane deviation stays centimetres, so it must stay ONE surface.
    // Base plane at a generic angle (normal far from the canonicalisation
    // flip boundary), twisted bilinearly like the GDI data.
    const z = (x, y) => 0.5 * x + 0.002 * x * (y / 10);
    const triangles = [];
    for (let x = 0; x < 12; x += 3) {
        const a = [x, 0, z(x, 0)], b = [x + 3, 0, z(x + 3, 0)];
        const c = [x + 3, 10, z(x + 3, 10)], d = [x, 10, z(x, 10)];
        triangles.push([a, b, c], [a, c, d]);
    }
    const surfaces = buildLogicalFacadeSurfaces(triangles);
    assert.equal(surfaces.length, 1, `expected one surface, got ${surfaces.length}`);
    assert.ok(surfaces[0].maxU - surfaces[0].minU > 11.5);
});

test('cooperative topology yields without changing the exact surface result', () => {
    const makeTriangles = () => {
        const triangles = [];
        for (let x = 0; x < 160; x += 4) triangles.push(...strip(x, x + 4));
        return triangles;
    };
    const expected = buildLogicalFacadeSurfaces(makeTriangles());
    const iterator = buildLogicalFacadeSurfacesCooperative(makeTriangles());
    const phases = [];
    let next = iterator.next();
    while (!next.done) {
        phases.push(next.value.phase);
        next = iterator.next();
    }

    assert.deepEqual(next.value, expected);
    assert.ok(phases.includes('facade-describe'));
    assert.ok(phases.includes('facade-connectivity'));
    assert.ok(phases.includes('facade-surface-groups'));
});

test('dense facade coverage prepares cooperatively and stays exact', () => {
    const triangles = [];
    for (let u = 0; u < 160; u += 1) {
        const a = { u, v: 0 };
        const b = { u: u + 1, v: 0 };
        const c = { u: u + 1, v: 10 };
        const d = { u, v: 10 };
        triangles.push([a, b, c], [a, c, d]);
    }
    const surface = { triangles };
    const iterator = prepareFacadeCoverageIndexCooperative(surface);
    const phases = [];
    let next = iterator.next();
    while (!next.done) {
        phases.push(next.value.phase);
        next = iterator.next();
    }

    assert.ok(phases.includes('facade-coverage-index'));
    assert.equal(rectangleFullyCoveredBySurface(surface, {
        minU: 42.25,
        maxU: 43.75,
        minV: 2,
        maxV: 8,
    }), true);
    assert.equal(rectangleFullyCoveredBySurface(surface, {
        minU: 159.25,
        maxU: 160.25,
        minV: 2,
        maxV: 8,
    }), false);

    // Every later opening or passage repaint reuses the completed immutable
    // surface index instead of repeating any preparation work.
    assert.equal(prepareFacadeCoverageIndexCooperative(surface).next().done, true);
});
