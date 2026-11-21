// Locks the boat's hull sections and the airplane's authored lofts without loading the renderer.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AIRPLANE_CABIN_SECTIONS,
    AIRPLANE_LANDING_GEAR_ASSEMBLIES,
    airplaneCabinSurfaceXAt,
    buildAirplaneCabinSidePatchGeometryData,
    buildAirplaneCabinSurfaceLinePositions,
    buildAirplaneCabinGeometryData,
    buildAirplaneFuselageGeometryData,
    buildAirplaneWingGeometryData,
    buildEllipticalLoftGeometryData,
    BOAT_HULL_DIMENSIONS,
    BOAT_HULL_SECTIONS,
} from '../models/vehicles/boat-airplane-geometry.js';

// Signed volume of a closed triangle soup. Positive means every face is wound
// counter-clockwise seen from OUTSIDE, which is what backface culling needs.
// The old check only compared two cap triangles in the XY plane, so it read the
// same for a hull and for its inside-out twin and could not fail.
function signedVolume(data) {
    let volume = 0;
    for (let index = 0; index + 2 < data.indices.length; index += 3) {
        const [a, b, c] = [0, 1, 2].map((corner) => {
            const vertex = data.indices[index + corner] * 3;
            return data.positions.slice(vertex, vertex + 3);
        });
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return volume;
}

function edgeUseCounts(data) {
    const counts = new Map();
    for (let index = 0; index + 2 < data.indices.length; index += 3) {
        const triangle = data.indices.slice(index, index + 3);
        for (let edge = 0; edge < 3; edge += 1) {
            const a = triangle[edge];
            const b = triangle[(edge + 1) % 3];
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return counts;
}

test('boat hull sections follow the leut lines: keel under the sheer, fine bow, rising sheer', () => {
    const sections = BOAT_HULL_SECTIONS;
    assert.ok(sections.length >= 8);
    // the stem head is a point at the sheer; every other section has depth
    for (const section of sections.slice(0, -1)) assert.ok(section.keelY < section.topY);
    assert.ok(sections.at(-1).keelY <= sections.at(-1).topY);
    assert.ok(sections.at(-1).halfWidth < sections[1].halfWidth * 0.1);
    assert.ok(sections.at(-1).z > sections[0].z + 8);
    assert.ok(sections.at(-1).topY > sections[2].topY + 0.35);
    assert.ok(sections.slice(0, -1).every(section => section.topY > 0.6));
    const widest = Math.max(...sections.map(section => section.halfWidth));
    assert.ok(widest > 1.3 && widest * 2 <= BOAT_HULL_DIMENSIONS.width);
    assert.ok(Math.max(...sections.map(section => Math.abs(section.z))) * 2 <= BOAT_HULL_DIMENSIONS.length);
});

test('airplane fuselage rises and narrows continuously into its tail', () => {
    const data = buildAirplaneFuselageGeometryData();
    assert.equal(data.radialSegments, 16);
    assert.ok(data.positions.length > 300);
    assert.ok(data.indices.length > 500);
    const aft = data.sections.filter(section => section.z <= -1.55);
    for (let index = 1; index < aft.length; index += 1) {
        assert.ok(aft[index].z < aft[index - 1].z, 'aft sections progress rearward');
        assert.ok(aft[index].centerY > aft[index - 1].centerY, 'tail centreline rises');
        assert.ok(aft[index].halfWidth < aft[index - 1].halfWidth, 'tail narrows laterally');
        assert.ok(aft[index].halfHeight < aft[index - 1].halfHeight, 'tail narrows vertically');
    }
    assert.ok(data.sections.at(-1).halfWidth < data.sections[4].halfWidth * 0.15);
});

test('airplane fuselage and cabin are closed and wound outward', () => {
    for (const data of [
        buildAirplaneFuselageGeometryData(),
        buildAirplaneCabinGeometryData(),
    ]) {
        assert.ok([...edgeUseCounts(data).values()].every(count => count === 2));
        assert.ok(signedVolume(data) > 0, 'faces point out of the hull, not into it');
    }
});

test('a loft authored tail-first still comes out wound outward', () => {
    // The cabin is authored aft-first; the builder has to normalise the order or
    // the whole greenhouse renders inside out and its rear disappears.
    const reversed = [...AIRPLANE_CABIN_SECTIONS].reverse();
    const data = buildEllipticalLoftGeometryData(reversed);
    assert.ok(signedVolume(data) > 0);
    assert.ok(data.sections[0].z > data.sections.at(-1).z, 'sections are normalised nose-first');
});

test('airplane has a rounded cabin above a low Cessna-like engine cowling', () => {
    const fuselage = buildAirplaneFuselageGeometryData();
    const cabin = buildAirplaneCabinGeometryData();
    const cowling = fuselage.sections.filter(section => section.z >= 1.55);
    assert.ok(cowling.every(section => section.centerY + section.halfHeight <= 1.25));
    assert.ok(cowling.every(section => section.halfWidth <= 0.58));
    assert.ok(cabin.positions.length > 180);
    assert.ok(cabin.indices.length > 250);
    assert.ok(cabin.sections[1].halfWidth > cabin.sections[0].halfWidth);
    assert.ok(cabin.sections.at(-1).halfWidth < cabin.sections.at(-2).halfWidth);
    assert.ok(cabin.sections[1].halfHeight > cabin.sections[0].halfHeight);
    assert.ok(cabin.sections.at(-1).halfHeight < cabin.sections.at(-2).halfHeight);
});

test('airplane side glazing and door lines are draped on the cabin ellipse', () => {
    const patch = buildAirplaneCabinSidePatchGeometryData({ side: -1 });
    for (let index = 0; index + 2 < patch.positions.length; index += 3) {
        const [x, y, z] = patch.positions.slice(index, index + 3);
        assert.ok(Math.abs(x - airplaneCabinSurfaceXAt(z, y, -1)) < 1e-9);
    }
    const outline = buildAirplaneCabinSurfaceLinePositions([
        { z: 0.38, y: 0.94 },
        { z: 0.43, y: 1.62 },
        { z: 1.47, y: 1.57 },
        { z: 1.50, y: 0.94 },
        { z: 0.38, y: 0.94 },
    ], { side: 1, segmentsPerEdge: 4 });
    for (let index = 0; index + 2 < outline.length; index += 3) {
        const [x, y, z] = outline.slice(index, index + 3);
        assert.ok(Math.abs(x - airplaneCabinSurfaceXAt(z, y, 1)) < 1e-9);
    }
});

test('airplane wing geometry tapers, rounds its tips, and bevels its edges', () => {
    const data = buildAirplaneWingGeometryData({
        span: 8.6,
        rootChord: 1.55,
        tipChord: 0.82,
        tipRadius: 0.24,
        tipSegments: 6,
    });
    assert.ok(data.positions.length > data.outline.length * 9);
    assert.ok(data.indices.length >= data.outline.length * 18);
    assert.ok(Math.max(...data.outline.map(point => Math.abs(point.x))) > 4.2);
    const rootDepth = Math.max(...data.outline.filter(point => point.x === 0).map(point => Math.abs(point.z)));
    const tipPoints = data.outline.filter(point => Math.abs(point.x) > 3.9);
    assert.ok(Math.max(...tipPoints.map(point => Math.abs(point.z))) < rootDepth);
    assert.ok(new Set(tipPoints.map(point => point.x.toFixed(3))).size > 2, 'tip follows a curve');
});

test('airplane has symmetric main gear plus one nose-wheel assembly', () => {
    assert.equal(AIRPLANE_LANDING_GEAR_ASSEMBLIES.length, 3);
    const [left, right, nose] = AIRPLANE_LANDING_GEAR_ASSEMBLIES;
    assert.equal(left.name, 'main-left');
    assert.equal(right.name, 'main-right');
    assert.equal(nose.name, 'nose');
    assert.equal(left.x, -right.x);
    assert.equal(left.z, right.z);
    assert.equal(nose.x, 0);
    assert.ok(nose.z > left.z + 2);
});

test('one-sided vertical tail keeps a full root edge and a tapered rounded tip', () => {
    const data = buildAirplaneWingGeometryData({
        span: 1.55,
        rootChord: 1.3,
        tipChord: 0.42,
        oneSided: true,
    });
    const root = data.outline.filter(point => point.x === 0);
    assert.deepEqual(root.map(point => point.z), [-0.65, 0.65]);
    assert.ok(Math.max(...data.outline.map(point => point.x)) > 1.5);
    assert.ok(data.outline.every(point => point.x >= 0));
});
