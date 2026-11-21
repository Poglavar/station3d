import assert from 'node:assert/strict';
import test from 'node:test';

import {
    nextWalkCameraMode,
    thirdPersonWalkCameraPose,
    walkCameraModeAfterVehicleExit,
    walkerAvatarVisible,
} from '../core/walk-camera.js';
import {
    beginWalkParachute,
    clearWalkKeys,
    createWalkState,
    onKeyDown,
    onKeyUp,
    stepWalk,
} from '../modes/walk.js';

test('C alternates the walker between first- and third-person views', () => {
    assert.equal(nextWalkCameraMode('first'), 'third');
    assert.equal(nextWalkCameraMode('third'), 'first');
    assert.equal(nextWalkCameraMode('unknown'), 'third');
});

test('exiting any GTA vehicle returns the walker to third person', () => {
    assert.equal(walkCameraModeAfterVehicleExit(), 'third');
});

test('third-person walker camera stays behind the gaze and looks past the avatar', () => {
    const pose = thirdPersonWalkCameraPose({
        x: 10,
        feetY: 3,
        z: 20,
        forwardX: 0,
        forwardZ: -1,
    });
    assert.equal(pose.x, 10);
    assert.ok(pose.z > 20, 'camera is behind a player looking toward -Z');
    assert.ok(pose.y > 5, 'camera clears the avatar head');
    assert.ok(pose.lookZ < 20, 'camera looks ahead of the avatar');
});

test('third-person pitch is bounded before calculating the look target', () => {
    const steep = thirdPersonWalkCameraPose({ pitchRad: 100 });
    assert.ok(Number.isFinite(steep.lookY));
    assert.ok(steep.lookY < 4);
});

test('a passage wall pulls the third-person camera in without moving the walker or look target', async () => {
 const {resolveWalkCameraPose}=await import('../core/walk-camera.js');
 const target={x:0,y:1.7,z:0},desired=thirdPersonWalkCameraPose();
 const wall={cx:0,cz:2,hx:5,hz:.1,cos:1,sin:0,minY:0,maxY:4};
 const result=resolveWalkCameraPose(target,desired,[wall]);
 assert.ok(result.z<1.7 && result.z>1.5);
 assert.equal(result.lookZ,desired.lookZ);
 assert.deepEqual(target,{x:0,y:1.7,z:0});
 assert.equal(resolveWalkCameraPose(target,desired,[{...wall,minY:4,maxY:5}]),desired);
});

test('camera clearance handles a rotated wall and releases after the corner clears',async()=>{
 const {resolveWalkCameraPose}=await import('../core/walk-camera.js');
 const target={x:0,y:1.7,z:0};
 const desired={x:5,y:2.7,z:0,lookX:-2,lookY:1,lookZ:0};
 const wall={cx:2,cz:0,hx:5,hz:.1,cos:0,sin:1,minY:0,maxY:4};
 assert.ok(resolveWalkCameraPose(target,desired,[wall]).x<1.7);
 assert.equal(resolveWalkCameraPose({...target,z:8},{...desired,z:8},[wall]).x,5);
});

test('the walker body shows in third person and in films, never in a dialogue shot', () => {
    const walking = { walkMode: true, terrainReady: true };
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'third' }), true);
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'first' }), false);
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'first', filmActive: true }), true, 'a film is of the walker');
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'third', filmActive: true, standInFilming: true }), false,
        'a set piece filming its own stand-in replaces the walker');
    // The speaker shot's camera stands on the player's side: the body would hide the speaker.
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'third', dialogueShotActive: true }), false);
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'first', filmActive: true, dialogueShotActive: true }), false);
    assert.equal(walkerAvatarVisible({ ...walking, walkCameraMode: 'third', driving: true }), false);
    assert.equal(walkerAvatarVisible({ walkMode: true, walkCameraMode: 'third', terrainReady: false }), false);
    assert.equal(walkerAvatarVisible({
        walkMode: true,
        walkCameraMode: 'third',
        terrainReady: false,
        airborne: true,
    }), true, 'airborne walker stays visible across a transient ground miss');
    assert.equal(walkerAvatarVisible({ walkCameraMode: 'third', terrainReady: true }), false);
});

test('a steering parachutist stays visible across transient ground misses', (t) => {
    t.after(() => {
        clearWalkKeys();
        onKeyUp('w');
        onKeyUp('a');
    });
    const ws = createWalkState(43.07, 16.19, { initialY: 0, initialGroundY: 0 });
    assert.equal(beginWalkParachute(ws, {
        lat: 43.07, lon: 16.19, y: 80, yaw: 0,
    }), true);
    onKeyDown('w');
    onKeyDown('a');
    const supportSamples = [null, 0, null, 0, null, 0];
    for (const sample of supportSamples) {
        const pose = stepWalk(ws, 1 / 30, 0, () => sample, (lat, lon) => ({
            x: lon * 1000,
            z: -lat * 1000,
        }), null);
        assert.equal(pose.parachute, true);
        assert.equal(walkerAvatarVisible({
            walkMode: true,
            walkCameraMode: 'third',
            terrainReady: pose.supportReady,
            airborne: pose.airborne,
        }), true);
    }
    assert.notEqual(ws.lat, 43.07, 'WASD steering advanced the parachutist');
    assert.notEqual(ws.yaw, 0, 'WASD steering turned the parachutist');
    assert.equal(walkerAvatarVisible({
        walkMode: true, walkCameraMode: 'first', terrainReady: false, airborne: true,
    }), false);
    assert.equal(walkerAvatarVisible({
        walkMode: true, walkCameraMode: 'third', terrainReady: false, airborne: true,
        dialogueShotActive: true,
    }), false);
    assert.equal(walkerAvatarVisible({
        walkMode: true, walkCameraMode: 'third', terrainReady: false, airborne: true,
        standInFilming: true,
    }), false);
});
