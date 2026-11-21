// Headless checks for the procedural Overture height and pitched-roof geometry.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFootprintWallGeometry,
    buildOvertureFacadeBatches,
    buildGabledRoofGeometry,
    buildHippedRoofGeometry,
    estimateOvertureBuildingHeight,
    footprintMinWidthM,
    proceduralRoofHeightM,
    ringAreaM2,
} from '../core/overture-building-shape.js';

const latitude = 43.51;
const metresPerLon = 111320 * Math.cos(latitude * Math.PI / 180);
const metresPerLat = 111320;

function rectangle(width, depth) {
    const lon = 16.44;
    const lat = latitude;
    const dx = width / metresPerLon;
    const dy = depth / metresPerLat;
    return [[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy], [lon, lat]];
}

test('measures a lon/lat footprint in square metres', () => {
    assert.ok(Math.abs(ringAreaM2(rectangle(10, 20), latitude) - 200) < 1);
});

test('builds metric wall UVs for low-rise facade overlays', () => {
    const polygon = { type: 'Polygon', coordinates: [rectangle(10, 20)] };
    const wall = buildFootprintWallGeometry(polygon, 6.4, 16.44, latitude);
    assert.equal(wall.positions.length, 4 * 6 * 3);
    assert.equal(wall.uvs.length, 4 * 6 * 2);
    const verticalUvs = wall.uvs.filter((_value, index) => index % 2 === 1);
    assert.equal(Math.min(...verticalUvs), 0);
    assert.equal(Math.max(...verticalUvs), 6.4);
});

test('estimates a stable multi-storey height when Overture has none', () => {
    const geometry = { type: 'Polygon', coordinates: [rectangle(12, 20)] };
    const first = estimateOvertureBuildingHeight(geometry, 12345, latitude);
    assert.equal(estimateOvertureBuildingHeight(geometry, 12345, latitude), first);
    assert.ok(first >= 6 && first <= 10);
});

test('measures the narrowest plan dimension, not the longest', () => {
    assert.ok(Math.abs(footprintMinWidthM(rectangle(2, 8), latitude) - 2) < 0.05);
    // An L cannot be narrower than its convex hull: the tightest pair of
    // parallel lines round this one is the diagonal across the notch, 4·√2.
    const lon = 16.44;
    const dx = 1 / metresPerLon;
    const dy = 1 / metresPerLat;
    const lShape = [
        [lon, latitude], [lon + 6 * dx, latitude], [lon + 6 * dx, latitude + 2 * dy],
        [lon + 2 * dx, latitude + 2 * dy], [lon + 2 * dx, latitude + 6 * dy],
        [lon, latitude + 6 * dy], [lon, latitude],
    ];
    assert.ok(Math.abs(footprintMinWidthM(lShape, latitude) - 4 * Math.SQRT2) < 0.2);
});

// The bug this locks out: every size band, sheds included, could take the
// seed > 0.94 landmark bonus, so 8 m² outbuildings came out 16 m tall. Both
// assertions go red if either the area gate or the slenderness clamp is removed.
test('never stands a tower on a shed-sized footprint', () => {
    for (let id = 0; id < 400; id++) {
        const shed = { type: 'Polygon', coordinates: [rectangle(2, 4)] };
        const height = estimateOvertureBuildingHeight(shed, `shed-${id}`, latitude);
        assert.ok(height <= 2 * 3.5 + 1e-9, `shed ${id} came out ${height.toFixed(1)} m tall`);
        assert.ok(height >= 3.2 - 1e-9);
    }
});

// What the world actually draws is wall + pitched roof, so that is what the
// slenderness limit has to hold — clamping the wall alone leaves the roof free
// to push the silhouette back past the limit.
test('the slenderness limit covers the roof, not just the walls', () => {
    for (const [width, depth] of [[1.2, 5], [2, 4], [2.5, 6], [3, 9]]) {
        const ring = rectangle(width, depth);
        const shape = { type: 'Polygon', coordinates: [ring] };
        const roof = proceduralRoofHeightM(ring, latitude) || 0;
        assert.ok(roof > 0, `${width}x${depth} m should still get a roof`);
        for (let id = 0; id < 120; id++) {
            const total = estimateOvertureBuildingHeight(shape, `roofed-${width}-${id}`, latitude)
                + roof;
            // 3.2 m is the one-storey floor; below that budget the floor wins
            // by design and a shed stays a shed.
            const limit = Math.max(3.2 + roof, width * 3.5);
            assert.ok(total <= limit + 1e-9,
                `${width}x${depth} m #${id} reached ${total.toFixed(1)} m over a limit of ${limit.toFixed(1)} m`);
        }
    }
});

// The clamp must bite on sheds without flattening the narrow-but-real house:
// 5 m across and three storeys up is ordinary inside Diocletian's palace.
test('still allows a slender old-town house its storeys', () => {
    const house = { type: 'Polygon', coordinates: [rectangle(5, 12)] };
    for (let id = 0; id < 50; id++) {
        const height = estimateOvertureBuildingHeight(house, `house-${id}`, latitude);
        assert.ok(height >= 6 && height <= 17.5, `house ${id} came out ${height.toFixed(1)} m tall`);
    }
});

test('builds upward-facing roof triangles and skips warehouse-sized roofs', () => {
    const ring = rectangle(10, 20);
    const polygon = { type: 'Polygon', coordinates: [ring] };
    const roofHeight = proceduralRoofHeightM(ring, latitude);
    assert.ok(roofHeight >= 1.4 && roofHeight <= 3.5);
    const geometry = buildHippedRoofGeometry(polygon, 8, roofHeight, 16.44, latitude);
    assert.equal(geometry.positions.length, 4 * 9);
    assert.equal(geometry.uvs.length, 4 * 6);
    for (let offset = 0; offset < geometry.positions.length; offset += 9) {
        const p = geometry.positions.slice(offset, offset + 9);
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
        const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        assert.ok(uz * vx - ux * vz > 0);
        assert.ok(vy > uy);
    }
    for (let offset = 0; offset < geometry.uvs.length; offset += 6) {
        const [aU, aV, bU, bV, apexU, apexV] = geometry.uvs.slice(offset, offset + 6);
        assert.equal(aU, 0);
        assert.equal(aV, 0);
        assert.equal(bV, 0);
        assert.ok(bU > 0);
        assert.ok(Math.abs(apexU - bU * 0.5) < 1e-9);
        assert.ok(apexV > roofHeight);
    }
    assert.equal(proceduralRoofHeightM(rectangle(40, 30), latitude), null);
});

test('builds a two-sided gable along the long footprint axis', () => {
    const polygon = { type: 'Polygon', coordinates: [rectangle(20, 10)] };
    const geometry = buildGabledRoofGeometry(polygon, 8, 2, 16.44, latitude);
    assert.ok(geometry);
    assert.equal(geometry.positions.length % 9, 0);
    assert.equal(geometry.uvs.length * 3, geometry.positions.length * 2);
    assert.ok(geometry.gablePositions.length >= 18);

    const ridgeVertices = [];
    for (let offset = 0; offset < geometry.positions.length; offset += 3) {
        const [x, y, z] = geometry.positions.slice(offset, offset + 3);
        assert.ok(y >= 8 - 1e-9 && y <= 10 + 1e-9);
        if (Math.abs(y - 10) < 1e-7) ridgeVertices.push({ x, z });
    }
    assert.ok(ridgeVertices.length >= 2);
    assert.ok(Math.max(...ridgeVertices.map(({ x }) => x))
        - Math.min(...ridgeVertices.map(({ x }) => x)) > 19);
    assert.ok(Math.max(...ridgeVertices.map(({ z }) => z))
        - Math.min(...ridgeVertices.map(({ z }) => z)) < 0.01);

    for (let offset = 0; offset < geometry.positions.length; offset += 9) {
        const p = geometry.positions.slice(offset, offset + 9);
        const ux = p[3] - p[0], uz = p[5] - p[2];
        const vx = p[6] - p[0], vz = p[8] - p[2];
        assert.ok(uz * vx - ux * vz > 0);
    }
});

test('batches Overture facade quads by metric bay count', () => {
    const polygon = { type: 'Polygon', coordinates: [rectangle(20, 10)] };
    const batches = buildOvertureFacadeBatches(polygon, 9, 16.44, latitude);
    assert.deepEqual(batches.map(({ bays, faceCount }) => ({ bays, faceCount })), [
        { bays: 2, faceCount: 2 },
        { bays: 4, faceCount: 2 },
    ]);
    assert.equal(batches.reduce((count, batch) => count + batch.positions.length, 0), 72);
    assert.ok(batches.every((batch) => batch.uvs.length * 3 === batch.positions.length * 2));
    assert.deepEqual(
        [...new Set(batches.flatMap((batch) => batch.positions.filter((_, index) => index % 3 === 1)))],
        [0, 9],
    );
    assert.ok(batches.every((batch) => batch.courtyard === false));
});

// A footprint hole is a courtyard, and its walls are facades too. Reading only
// coordinates[0] left every courtyard-facing wall as blank plaster from lawn
// to roofline — first seen inside the Šibenik plan's perimeter blocks.
test('courtyard walls get their own facade batches, flagged for plain glazing', () => {
    // Outer 30×20 with an 18×8 court: the 20 m street sides and the 18 m court
    // sides both round to 4 bays, so the flag — not the bay count — must keep
    // them in separate batches (shopfronts belong on the street only).
    const hole = rectangle(18, 8)
        .map(([lon, lat]) => [lon + 6 / metresPerLon, lat + 6 / metresPerLat])
        .reverse();
    const polygon = { type: 'Polygon', coordinates: [rectangle(30, 20), hole] };
    const batches = buildOvertureFacadeBatches(polygon, 9, 16.44, latitude);
    assert.deepEqual(batches.map(({ bays, courtyard, faceCount }) => ({ bays, courtyard, faceCount })), [
        { bays: 2, courtyard: true, faceCount: 2 },
        { bays: 4, courtyard: false, faceCount: 2 },
        { bays: 4, courtyard: true, faceCount: 2 },
        { bays: 7, courtyard: false, faceCount: 2 },
    ]);
    // Court walls span the full height like any facade.
    for (const batch of batches) {
        const heights = new Set(batch.positions.filter((_, index) => index % 3 === 1));
        assert.deepEqual([...heights].sort((a, b) => a - b), [0, 9]);
    }
});
