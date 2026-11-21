// Verifies pedestrian routes detour around streamed building boundaries and
// still reach exterior door points without crossing another facade edge.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    footprintMatchesRenderedBounds,
    movementCrossesBuildingFootprints,
    planFootprintAwareRoute,
    pointInBuildingFootprint,
    routeCrossesBuildingFootprints,
} from '../core/pedestrian-routing.js';

const rectangle = {
    objectId: 'block',
    minX: -2,
    maxX: 2,
    minZ: -3,
    maxZ: 3,
    segments: [
        { ax: -2, az: -3, bx: 2, bz: -3, normalX: 0, normalZ: -1 },
        { ax: 2, az: -3, bx: 2, bz: 3, normalX: 1, normalZ: 0 },
        { ax: 2, az: 3, bx: -2, bz: 3, normalX: 0, normalZ: 1 },
        { ax: -2, az: 3, bx: -2, bz: -3, normalX: -1, normalZ: 0 },
    ],
};

test('detects points inside an unordered footprint boundary', () => {
    assert.equal(pointInBuildingFootprint({ x: 0, z: 0 }, rectangle), true);
    assert.equal(pointInBuildingFootprint({ x: -2.5, z: 0 }, rectangle), false);
    assert.equal(pointInBuildingFootprint({ x: 0, z: 0 }, { ...rectangle, closed: false }), false);
});

test('routes a pedestrian around a building instead of through its walls', () => {
    const start = { x: -6, z: 0 };
    const destination = { x: 6, z: 0 };
    const route = planFootprintAwareRoute(start, destination, [rectangle]);

    assert.ok(route);
    assert.ok(route.length > 1);
    assert.deepEqual(route.at(-1), destination);
    assert.equal(routeCrossesBuildingFootprints(start, route, [rectangle]), false);
});

test('approaches an exterior door from the far side without crossing the building', () => {
    const start = { x: 6, z: 0 };
    const exteriorDoor = { x: -2.45, z: 0 };
    const route = planFootprintAwareRoute(start, exteriorDoor, [rectangle]);

    assert.ok(route);
    assert.ok(route.length > 1);
    assert.deepEqual(route.at(-1), exteriorDoor);
    assert.equal(routeCrossesBuildingFootprints(start, route, [rectangle]), false);
});

test('bounds detour graph size for a survey-detailed building outline', () => {
    const segments = [];
    const samples = 240;
    for (let index = 0; index < samples; index++) {
        const a = index / samples * Math.PI * 2;
        const b = (index + 1) / samples * Math.PI * 2;
        segments.push({
            ax: Math.cos(a) * 3,
            az: Math.sin(a) * 3,
            bx: Math.cos(b) * 3,
            bz: Math.sin(b) * 3,
        });
    }
    const detailed = {
        objectId: 'survey-detailed',
        minX: -3,
        maxX: 3,
        minZ: -3,
        maxZ: 3,
        segments,
    };
    const start = { x: -8, z: 0 };
    const destination = { x: 8, z: 0 };
    const route = planFootprintAwareRoute(start, destination, [detailed]);

    assert.ok(route);
    assert.ok(route.length <= 5);
    assert.deepEqual(route.at(-1), destination);
    assert.equal(routeCrossesBuildingFootprints(start, route, [detailed]), false);
});

test('rejects an individual movement step through a wall', () => {
    assert.equal(movementCrossesBuildingFootprints(
        { x: -2.2, z: 0 },
        { x: -1.8, z: 0 },
        [rectangle],
    ), true);
    assert.equal(movementCrossesBuildingFootprints(
        { x: -4, z: 0 },
        { x: -3.5, z: 0 },
        [rectangle],
    ), false);
});

test('accepts matching closed and detailed bounds but rejects malformed outliers', () => {
    const detailed = {
        ...rectangle,
        renderedBounds: { minX: -2.1, maxX: 2.1, minZ: -3.1, maxZ: 3.1 },
    };
    assert.equal(footprintMatchesRenderedBounds(detailed, {
        minX: -2,
        maxX: 2,
        minZ: -3,
        maxZ: 3,
    }), true);
    assert.equal(footprintMatchesRenderedBounds(detailed, {
        minX: -80,
        maxX: 80,
        minZ: -100,
        maxZ: 100,
    }), false);
});
