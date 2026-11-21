import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPlayerWalkerAvatar,
    updatePlayerWalkerAvatar,
} from '../world/player-walker-avatar.js';

test('the player avatar reuses the pedestrian stick figure and carries a jetpack', () => {
    const avatar = createPlayerWalkerAvatar();
    const state = avatar.userData.playerWalker;
    assert.equal(avatar.name, 'PlayerWalker');
    assert.ok(state.person.userData.walkLimbs);
    assert.equal(state.jetpack.name, 'PlayerJetpack');
    assert.ok(state.flames.length >= 2);
});

test('jetpack exhaust is visible only while the avatar is flying under thrust', () => {
    const avatar = createPlayerWalkerAvatar();
    updatePlayerWalkerAvatar(avatar, {
        x: 4,
        y: 7,
        z: -2,
        headingRad: 1,
        airborne: true,
        jetpackActive: true,
        elapsedSeconds: 0.5,
        visible: true,
    });
    assert.deepEqual(avatar.position.toArray(), [4, 7, -2]);
    assert.equal(avatar.visible, true);
    assert.ok(avatar.userData.playerWalker.flames.every(flame => flame.mesh.visible));

    updatePlayerWalkerAvatar(avatar, { jetpackActive: false, visible: false });
    assert.equal(avatar.visible, false);
    assert.ok(avatar.userData.playerWalker.flames.every(flame => !flame.mesh.visible));
});

test('the jetpack itself is hidden when flight is disabled', () => {
    const avatar = createPlayerWalkerAvatar();
    const state = avatar.userData.playerWalker;

    updatePlayerWalkerAvatar(avatar, {
        airborne: true,
        jetpackActive: true,
        jetpackAvailable: false,
        visible: true,
    });

    assert.equal(state.jetpack.visible, false);
    assert.ok(state.flames.every(flame => !flame.mesh.visible));
    assert.equal(state.flightArmBlend, 0);
});

test('jetpack thrust raises both arms forward and release relaxes them gradually', () => {
    const avatar = createPlayerWalkerAvatar();
    const state = avatar.userData.playerWalker;
    const armEndpoints = (arm) => {
        const halfLength = arm.lengthM * 0.5;
        const sine = Math.sin(arm.mesh.rotation.x);
        const cosine = Math.cos(arm.mesh.rotation.x);
        return {
            shoulder: {
                y: arm.mesh.position.y + cosine * halfLength,
                z: arm.mesh.position.z + sine * halfLength,
            },
            hand: {
                y: arm.mesh.position.y - cosine * halfLength,
                z: arm.mesh.position.z - sine * halfLength,
            },
        };
    };

    for (let frame = 0; frame < 2; frame++) {
        updatePlayerWalkerAvatar(avatar, {
            airborne: true,
            jetpackActive: true,
            dt: 0.1,
        });
    }
    assert.equal(state.flightArmBlend, 1);
    assert.ok(state.flightArms.every(arm => arm.mesh.rotation.x < -1.5));
    for (const arm of state.flightArms) {
        const endpoints = armEndpoints(arm);
        assert.ok(Math.abs(endpoints.shoulder.y - arm.shoulderY) < 1e-9);
        assert.ok(Math.abs(endpoints.shoulder.z - arm.restZ) < 1e-9);
        assert.ok(endpoints.hand.z > arm.restZ + arm.lengthM * 0.9,
            'the hand, not the shoulder, must reach forward');
        assert.ok(Math.abs(endpoints.hand.y - arm.shoulderY) < 1e-9,
            'the fully raised hand reaches shoulder height');
    }

    updatePlayerWalkerAvatar(avatar, {
        airborne: true,
        jetpackActive: false,
        dt: 0.1,
    });
    assert.ok(state.flightArmBlend > 0.8,
        'letting go must not snap the arms straight back to rest');
    assert.ok(state.flightArms.every(arm => arm.mesh.rotation.x < -1.2));
    for (const arm of state.flightArms) {
        const endpoints = armEndpoints(arm);
        assert.ok(Math.abs(endpoints.shoulder.y - arm.shoulderY) < 1e-9);
        assert.ok(Math.abs(endpoints.shoulder.z - arm.restZ) < 1e-9);
        assert.ok(endpoints.hand.y < arm.shoulderY,
            'release lowers the hand while the shoulder stays still');
    }

    for (let frame = 0; frame < 10; frame++) {
        updatePlayerWalkerAvatar(avatar, {
            airborne: false,
            jetpackActive: false,
            dt: 0.1,
        });
    }
    assert.equal(state.flightArmBlend, 0);
    assert.ok(state.flightArms.every(arm => Math.abs(arm.mesh.rotation.x) < 1e-9));
    assert.ok(state.flightArms.every(arm => Math.abs(arm.mesh.position.z - arm.restZ) < 1e-9));
});
