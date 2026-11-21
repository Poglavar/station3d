// Verifies the pure camera-relative priority used before streamed geometry
// exists, including Station3D's 0° north / 90° east heading convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    classifyViewPriority,
    featureLocalBounds,
    horizontalFovDeg,
    resolveCameraViewHeadingDeg,
    tileLocalBounds,
    viewPriorityScore,
} from '../core/view-priority.js';

function square(centerX, centerZ, halfSize = 5) {
    return {
        minX: centerX - halfSize,
        maxX: centerX + halfSize,
        minZ: centerZ - halfSize,
        maxZ: centerZ + halfSize,
    };
}

test('an equally distant object in view outranks one behind the observer', () => {
    const view = { observerX: 0, observerZ: 0, headingDeg: 0, fovDeg: 90 };
    const north = classifyViewPriority(square(0, -100), view);
    const south = classifyViewPriority(square(0, 100), view);

    assert.equal(north.tier, 'visible');
    assert.equal(south.tier, 'hidden');
    assert.ok(north.score > south.score);
});

test('east-facing view follows the scene heading convention', () => {
    const view = { observerX: 0, observerZ: 0, headingDeg: 90, fovDeg: 70 };
    assert.equal(classifyViewPriority(square(80, 0), view).tier, 'visible');
    assert.equal(classifyViewPriority(square(-80, 0), view).tier, 'hidden');
});

test('bounds intersecting the view remain visible when their centroid is outside it', () => {
    const view = { observerX: 0, observerZ: 0, headingDeg: 0, fovDeg: 60 };
    const wideBuilding = {
        minX: 35,
        maxX: 95,
        minZ: -100,
        maxZ: -70,
    };
    const priority = classifyViewPriority(wideBuilding, view);

    assert.equal(priority.tier, 'visible');
    assert.ok(priority.angularRadiusDeg > 10);
});

test('a close visible building outranks a distant building at screen centre', () => {
    const view = { observerX: 0, observerZ: 0, headingDeg: 0, fovDeg: 90 };
    const closeAtEdge = square(30, -30, 5);
    const distantAtCentre = square(0, -500, 5);
    assert.equal(classifyViewPriority(closeAtEdge, view).tier, 'visible');
    assert.ok(
        viewPriorityScore(closeAtEdge, view) > viewPriorityScore(distantAtCentre, view),
    );
});

test('the observer-containing bounds keep support priority regardless of heading', () => {
    const result = classifyViewPriority(square(0, 0, 10), {
        observerX: 0,
        observerZ: 0,
        headingDeg: 180,
        fovDeg: 60,
    });
    assert.equal(result.tier, 'support');
    assert.ok(result.score > viewPriorityScore(square(0, 30), {
        observerX: 0,
        observerZ: 0,
        headingDeg: 180,
        fovDeg: 60,
    }));
});

test('tile bounds and GeoJSON feature bounds use matching local axes', () => {
    const anchorLat = 45;
    const anchorLon = 16;
    const northEastFeature = {
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [16.0001, 45.0001],
                [16.0002, 45.0001],
                [16.0002, 45.0002],
                [16.0001, 45.0001],
            ]],
        },
    };
    const bounds = featureLocalBounds(northEastFeature, anchorLat, anchorLon);

    assert.ok(bounds.minX > 0, 'east is +X');
    assert.ok(bounds.maxZ < 0, 'north is -Z');
    assert.deepEqual(tileLocalBounds(1, -2, 100), {
        minX: 100,
        maxX: 200,
        minZ: -200,
        maxZ: -100,
    });
});

test('horizontal FOV expands on a landscape viewport', () => {
    const horizontal = horizontalFovDeg(60, 16 / 9);
    assert.ok(horizontal > 90 && horizontal < 100);
});

test('camera view heading includes drag-look and rear-cab direction', () => {
    assert.equal(resolveCameraViewHeadingDeg({
        baseHeadingDeg: 20,
        lookYawRad: 30 * Math.PI / 180,
        cameraMode: 'cab',
    }), 50);
    assert.equal(resolveCameraViewHeadingDeg({
        baseHeadingDeg: 20,
        lookYawRad: 30 * Math.PI / 180,
        cameraMode: 'rear',
    }), 230);
    assert.equal(resolveCameraViewHeadingDeg({
        baseHeadingDeg: 20,
        lookYawRad: 30 * Math.PI / 180,
        cameraMode: 'third',
    }), 20);
    assert.equal(resolveCameraViewHeadingDeg({
        baseHeadingDeg: 350,
        lookYawRad: 30 * Math.PI / 180,
        cameraMode: 'rear',
        walkMode: true,
    }), 20);
});

test('world streaming compiles fetch, build, and cancellation from view priority', async () => {
    const [sharedSource, carsSource, farSource, combatSource] = await Promise.all([
        readFile(new URL('../core/shared-tile-session.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/cars.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/buildings-far.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/machine-gun-nests.js', import.meta.url), 'utf8'),
    ]);
    assert.match(sharedSource, /if \(entry && entry\.status !== 'loaded'\) return true/);
    assert.match(carsSource, /key: 'roads:traffic'/);
    assert.doesNotMatch(carsSource, /key: 'roads:graph'/);
    assert.match(carsSource, /priority: \(\) => classifyViewPriority/);
    assert.match(farSource, /prioritizeByView: true/);
    assert.match(farSource, /priority: \(\) => classifyViewPriority/);
    assert.match(combatSource, /key: 'roads:combat-streets'/);
});
