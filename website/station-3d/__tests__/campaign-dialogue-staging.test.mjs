// Locks the generic dialogue camera around the authored speaker/player axis
// and keeps radio conversations on the player's current view.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignDialogueCutOpacity,
    campaignDialogueGroundY,
    campaignDialogueShot,
    campaignDialogueSpeakerPlacement,
} from '../core/campaign-dialogue-staging.js';
import { geoToLocal, localToGeo } from '../core/math.js';

const speaker = { actorId: 'leader', lat: 45.8145, lon: 15.97304, headingDeg: 275 };
const scene = { authored: { actors: [speaker] } };
const player = localToGeo(0, 2.2, speaker.lon, speaker.lat);

test('dialogue staging frames a physical speaker and alternates later close-up sides', () => {
    assert.deepEqual(campaignDialogueSpeakerPlacement(scene, 'leader'), {
        actorId: 'leader',
        lat: speaker.lat,
        lon: speaker.lon,
        headingDeg: 275,
        dialogueElevationM: 0,
        seated: false,
        eyeHeightM: 1.48,
    });
    const establishing = campaignDialogueShot({
        scene,
        speakerId: 'leader',
        playerPose: player,
        beatIndex: 0,
    });
    const leftClose = campaignDialogueShot({
        scene,
        speakerId: 'leader',
        playerPose: player,
        beatIndex: 1,
    });
    const rightClose = campaignDialogueShot({
        scene,
        speakerId: 'leader',
        playerPose: player,
        beatIndex: 2,
    });
    const establishingLocal = geoToLocal(
        establishing.position.lon,
        establishing.position.lat,
        speaker.lon,
        speaker.lat,
    );
    const leftLocal = geoToLocal(
        leftClose.position.lon,
        leftClose.position.lat,
        speaker.lon,
        speaker.lat,
    );
    const rightLocal = geoToLocal(
        rightClose.position.lon,
        rightClose.position.lat,
        speaker.lon,
        speaker.lat,
    );

    assert.ok(Math.hypot(establishingLocal.x, establishingLocal.z) > 2.4);
    assert.equal(establishing.framing, 'dialogue', 'the frame owner must tell a speaker shot from a film');
    assert.deepEqual(establishing.groundReference, {
        lat: speaker.lat,
        lon: speaker.lon,
    });
    assert.equal(establishing.fovDeg, 52);
    assert.equal(leftClose.fovDeg, 42);
    assert.ok(leftLocal.x > 0, 'the second beat moves to one shoulder');
    assert.ok(rightLocal.x < 0, 'the third beat crosses to the other shoulder');
});

test('dialogue framing shares the speaker support instead of bare terrain below it', () => {
    assert.equal(campaignDialogueGroundY({
        roomFloorY: 8,
        authoredGroundY: 2.2,
        terrainGroundY: 1.55,
    }), 8);
    assert.equal(campaignDialogueGroundY({
        authoredGroundY: 2.2,
        terrainGroundY: 1.55,
    }), 2.2);
    assert.equal(campaignDialogueGroundY({ terrainGroundY: 1.55 }), 1.55);
    assert.equal(campaignDialogueGroundY(), null);
});

test('remote set-piece speakers use authored facing and deck elevation', () => {
    const elevatedSpeaker = {
        actorId: 'captain',
        ...localToGeo(3.6, 73, 16.24, 43.15),
        headingDeg: 270,
        dialogueElevationM: 1.5,
    };
    const remoteScene = { authored: { actors: [elevatedSpeaker] } };
    const remotePlayer = { lat: 43.15, lon: 16.24 };
    const shot = campaignDialogueShot({
        scene: remoteScene,
        speakerId: 'captain',
        playerPose: remotePlayer,
    });
    const cameraLocal = geoToLocal(
        shot.position.lon,
        shot.position.lat,
        elevatedSpeaker.lon,
        elevatedSpeaker.lat,
    );

    assert.ok(cameraLocal.x < -2, 'camera stays outside the captain’s port side');
    assert.ok(Math.abs(cameraLocal.z) < 1, 'camera follows authored facing, not a remote checkpoint');
    assert.ok(Math.abs(shot.position.heightM - 3.36) < 1e-9);
    assert.ok(Math.abs(shot.lookAt.heightM - 2.98) < 1e-9);
});

test('radio dialogue keeps the live view and cut fades honor reduced motion', () => {
    assert.equal(campaignDialogueShot({
        scene: { authored: {} },
        speakerId: 'leader',
        playerPose: player,
    }), null);
    assert.equal(campaignDialogueCutOpacity(0), 1);
    assert.equal(campaignDialogueCutOpacity(260), 0);
    assert.equal(campaignDialogueCutOpacity(90, { reducedMotion: true }), 0);
});

// The Vis fisherman sits on the quay edge facing the sea, and the player walks
// up behind him along the riva. A standing eyeline put his cap under the
// dialogue panel and a shot from the player's side showed his back.
test('a seated speaker is framed at his seated eyeline, not a standing one', () => {
    const scene = { authored: { actors: [
        { actorId: 'fisherman', lat: 43.06125, lon: 16.183958, headingDeg: 90, activity: { type: 'fishing' } },
        { actorId: 'granny', lat: 43.50491, lon: 16.44288, headingDeg: 90 },
    ] } };
    const seated = campaignDialogueSpeakerPlacement(scene, 'fisherman');
    assert.equal(seated.seated, true);
    assert.ok(seated.eyeHeightM > 0.7 && seated.eyeHeightM < 0.95, `seated eyeline ${seated.eyeHeightM}`);
    const standing = campaignDialogueSpeakerPlacement(scene, 'granny');
    assert.equal(standing.eyeHeightM, 1.48);

    const playerWest = { lat: 43.06125, lon: 16.183930 };
    const shot = campaignDialogueShot({ scene, speakerId: 'fisherman', playerPose: playerWest, beatIndex: 0 });
    assert.ok(Math.abs(shot.lookAt.heightM - seated.eyeHeightM) < 1e-9, 'the camera looks at the seated eyeline');
    assert.ok(shot.position.heightM < 1.3, `camera height ${shot.position.heightM}`);
    const close = campaignDialogueShot({ scene, speakerId: 'fisherman', playerPose: playerWest, beatIndex: 1 });
    assert.ok(close.position.heightM - close.lookAt.heightM > 0.1 && close.position.heightM - close.lookAt.heightM < 0.2);
    const standingShot = campaignDialogueShot({ scene, speakerId: 'granny', playerPose: { lat: 43.50491, lon: 16.44285 }, beatIndex: 0 });
    assert.ok(Math.abs(standingShot.position.heightM - 1.86) < 1e-9);
    assert.equal(standingShot.lookAt.heightM, 1.48);
});


test('authored interior framing and upper support reach the camera without changing default shots', () => {
    const elevatedScene = { authored: { actors: [{ ...speaker, support: 'highest',
        dialogueCamera: { distanceM: 1.45, sideM: 0, fovDeg: 40 } }] } };
    const shot = campaignDialogueShot({ scene: elevatedScene, speakerId: 'leader', playerPose: player });
    const camera = geoToLocal(shot.position.lon, shot.position.lat, speaker.lon, speaker.lat);
    assert.ok(Math.abs(Math.hypot(camera.x, camera.z) - 1.45) < 0.00001);
    assert.ok(Math.abs(camera.x) < 0.00001, 'a centered shot does not put the camera in the side wall');
    assert.equal(shot.groundReference.support, 'highest');
    assert.equal(shot.fovDeg, 40);
    assert.equal(campaignDialogueShot({ scene, speakerId: 'leader', playerPose: player }).fovDeg, 52);
});
