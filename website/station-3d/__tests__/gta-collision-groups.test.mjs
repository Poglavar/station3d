// Verifies wheel-ray isolation and the separate moving/static traffic groups
// that prevent route-guided ambient cars from building vertical piles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import RAPIER from '@dimforge/rapier3d-compat';

import { GTA_COLLISION_GROUPS } from '../core/gta-collision-groups.js';

await RAPIER.init();

const gtaSource = await readFile(new URL('../modes/gta.js', import.meta.url), 'utf8');

test('wheel ray groups ignore obstacles above the firm surface', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const supportBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const support = world.createCollider(
        RAPIER.ColliderDesc.cuboid(5, 0.05, 5)
            .setTranslation(0, -0.05, 0)
            .setCollisionGroups(GTA_COLLISION_GROUPS.support),
        supportBody,
    );
    const obstacleBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const obstacle = world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.4, 0.1, 0.4)
            .setTranslation(0, 0.4, 0)
            .setCollisionGroups(GTA_COLLISION_GROUPS.obstacle),
        obstacleBody,
    );
    world.step();
    const ray = new RAPIER.Ray({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 });
    const unfiltered = world.castRay(ray, 10, true);
    assert.equal(unfiltered?.collider.handle, obstacle.handle);
    const wheelHit = world.castRay(
        ray,
        10,
        true,
        undefined,
        GTA_COLLISION_GROUPS.wheelQuery,
    );
    assert.equal(wheelHit?.collider.handle, support.handle);
    world.free();
});

test('camera queries see support and the immutable world but ignore vehicles', () => {
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.cameraQuery,
        GTA_COLLISION_GROUPS.support,
    ), true);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.cameraQuery,
        GTA_COLLISION_GROUPS.obstacle,
    ), true);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.cameraQuery,
        GTA_COLLISION_GROUPS.chassis,
    ), false);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.cameraQuery,
        GTA_COLLISION_GROUPS.trafficMoving,
    ), false);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.cameraQuery,
        GTA_COLLISION_GROUPS.trafficStatic,
    ), false);
});

function groupsInteract(left, right) {
    const leftMembership = left >>> 16;
    const leftFilter = left & 0xffff;
    const rightMembership = right >>> 16;
    const rightFilter = right & 0xffff;
    return (leftMembership & rightFilter) !== 0
        && (rightMembership & leftFilter) !== 0;
}

test('route-guided moving traffic cannot stack on other moving traffic', () => {
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficMoving,
        GTA_COLLISION_GROUPS.trafficMoving,
    ), false);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficMoving,
        GTA_COLLISION_GROUPS.chassis,
    ), true, 'ambient cars must still collide with the player vehicle');
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficMoving,
        GTA_COLLISION_GROUPS.support,
    ), true, 'ambient cars must still stay on physical road support');
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficMoving,
        GTA_COLLISION_GROUPS.obstacle,
    ), true, 'ambient cars must still hit the physical world');
});

test('moving traffic still collides with parked cars, wrecks and trams', () => {
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficMoving,
        GTA_COLLISION_GROUPS.trafficStatic,
    ), true);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficStatic,
        GTA_COLLISION_GROUPS.trafficStatic,
    ), false);
    assert.equal(groupsInteract(
        GTA_COLLISION_GROUPS.trafficStatic,
        GTA_COLLISION_GROUPS.chassis,
    ), true);
    assert.match(
        gtaSource,
        /mode === 'dynamic'[\s\S]{0,100}trafficMoving[\s\S]{0,100}trafficStatic/,
        'the Rapier integration must assign the group from traffic ownership mode',
    );
});
