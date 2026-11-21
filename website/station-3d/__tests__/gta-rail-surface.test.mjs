// Verifies that GTA physics receives the same bounded tram-bed floor as rails.js renders.

import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

import { buildRailTrackbedTrimeshData } from '../core/gta-rail-surface.js';
import { physicsSurfaceSupportY } from '../core/gta-surface-recovery.js';

await RAPIER.init();

function segment(overrides = {}) {
    return {
        x1: -10,
        z1: 0,
        x2: 10,
        z2: 0,
        yStart: 0.2,
        yEnd: 0.4,
        startJoinX: 0,
        startJoinZ: -1,
        endJoinX: 0,
        endJoinZ: -1,
        startTrackbedHalfWidthM: 2,
        endTrackbedHalfWidthM: 2,
        startTrackbedInnerEdgeM: 0,
        endTrackbedInnerEdgeM: 0,
        startKey: 'a',
        endKey: 'b',
        sortKey: 'a>b',
        ...overrides,
    };
}

function colliderFor(data) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = world.createCollider(
        RAPIER.ColliderDesc.trimesh(data.vertices, data.indices),
        body,
    );
    return { world, collider };
}

test('rendered tram strips become continuous bounded Rapier support', () => {
    const data = buildRailTrackbedTrimeshData({
        segments: [
            segment(),
            segment({ x1: 100, x2: 120, startKey: 'far-a', endKey: 'far-b' }),
        ],
        centerX: 0,
        centerZ: 0,
        radiusM: 25,
        surfaceOffsetM: 0.075,
    });
    assert.equal(data.segmentCount, 1);
    assert.equal(data.triangleCount, 4);
    assert.equal(data.truncated, false);

    const { world, collider } = colliderFor(data);
    for (const [x, expectedY] of [[-8, 0.295], [0, 0.375], [8, 0.455]]) {
        const support = physicsSurfaceSupportY({
            RAPIER,
            surfaceColliders: [collider],
            physicsX: x,
            physicsZ: 1,
            supportProbeY: expectedY,
        });
        assert.ok(Math.abs(support - expectedY) < 1e-5,
            `trackbed support at x=${x} was ${support}`);
    }
    world.free();
});

test('CCD chassis cannot tunnel through the zero-thickness tram-bed mesh', () => {
    const data = buildRailTrackbedTrimeshData({
        segments: [segment({ yStart: 0, yEnd: 0 })],
        radiusM: 30,
    });
    const { world } = colliderFor(data);
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, 3, 1)
            .setLinvel(0, -30, 0)
            .setCcdEnabled(true),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 0.48, 1.8), chassis);
    let lowestY = Infinity;
    for (let frame = 0; frame < 120; frame += 1) {
        world.timestep = 1 / 60;
        world.step();
        lowestY = Math.min(lowestY, chassis.translation().y);
    }
    assert.ok(lowestY > 0.45, `chassis penetrated to y=${lowestY}`);
    assert.ok(chassis.translation().y > 0.45, `chassis ended at y=${chassis.translation().y}`);
    world.free();
});

test('station island opening remains open exactly as rendered', () => {
    const data = buildRailTrackbedTrimeshData({
        segments: [segment({
            yStart: 0,
            yEnd: 0,
            startTrackbedHalfWidthM: 3,
            endTrackbedHalfWidthM: 3,
            startTrackbedInnerEdgeM: 1,
            endTrackbedInnerEdgeM: 1,
        })],
        radiusM: 30,
    });
    const { world, collider } = colliderFor(data);
    const islandGap = physicsSurfaceSupportY({
        RAPIER,
        surfaceColliders: [collider],
        physicsX: 0,
        physicsZ: 0,
        supportProbeY: 0,
    });
    const pavedStrip = physicsSurfaceSupportY({
        RAPIER,
        surfaceColliders: [collider],
        physicsX: 0,
        physicsZ: 2,
        supportProbeY: 0,
    });
    assert.equal(islandGap, null);
    assert.ok(Math.abs(pavedStrip) < 1e-5);
    world.free();
});

test('switch throat receives the same fan patch as the rendered trackbed', () => {
    const shared = { x2: 0, z2: 0, endKey: 'switch' };
    const data = buildRailTrackbedTrimeshData({
        segments: [
            segment({ ...shared, x1: -10, z1: 0, startKey: 'west' }),
            segment({ x1: 0, z1: 0, x2: 10, z2: -8, startKey: 'switch', endKey: 'ne' }),
            segment({ x1: 0, z1: 0, x2: 10, z2: 8, startKey: 'switch', endKey: 'se' }),
        ],
        radiusM: 30,
        junctionSteps: 12,
    });
    assert.equal(data.junctionCount, 1);
    assert.equal(data.triangleCount, 24);
});

test('triangle budget keeps the nearest complete segment and reports truncation', () => {
    const data = buildRailTrackbedTrimeshData({
        segments: [
            segment({ x1: 30, x2: 40, startKey: 'far-a', endKey: 'far-b' }),
            segment({ x1: -5, x2: 5, startKey: 'near-a', endKey: 'near-b' }),
        ],
        radiusM: 100,
        maxTriangles: 4,
    });
    assert.equal(data.segmentCount, 1);
    assert.equal(data.triangleCount, 4);
    assert.equal(data.truncated, true);
    assert.ok(Math.abs(data.vertices[0] + 5) < 1e-6, 'nearest segment was retained');
});
