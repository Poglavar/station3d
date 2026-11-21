import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
    CAMPAIGN_FISHING_DEFAULTS,
    CAMPAIGN_FISHING_ROD_TIP_REACH_M,
    campaignFishingGripAnchor,
    campaignSeatedActorOffsetY,
    sampleCampaignFishingPose,
    sampleCampaignTypewriterPose,
    stepCampaignActorPatrol,
} from '../core/campaign-actor-activity.js';
import { animatePersonSit, createPersonMesh, disposePersonMeshSessionCaches } from '../world/person-mesh.js';

const MALE_DIMS = { legH: 0.72, bodyH: 0.76, armH: 0.6, armX: 0.2, headR: 0.15, bodyR: 0.17 };

function fishingPose(tS, options = {}) {
    return sampleCampaignFishingPose({ tS, dimensions: MALE_DIMS, ...options });
}

test('an ambient patrol reaches its waypoint without overshooting it', () => {
    const halfway = stepCampaignActorPatrol({
        actorX: 0,
        actorZ: 0,
        targetX: 2,
        targetZ: 0,
        speedMps: 1,
        dt: 0.5,
    });
    assert.deepEqual(halfway, {
        x: 0.5,
        z: 0,
        heading: Math.PI / 2,
        walking: true,
        arrived: false,
    });

    const arrived = stepCampaignActorPatrol({
        actorX: 1.95,
        actorZ: 0,
        targetX: 2,
        targetZ: 0,
        speedMps: 1,
        dt: 0.5,
    });
    assert.equal(arrived.x, 2);
    assert.equal(arrived.z, 0);
    assert.equal(arrived.walking, true);
    assert.equal(arrived.arrived, true);
});

test('typewriter work alternates the hands and advances the carriage', () => {
    const first = sampleCampaignTypewriterPose(0.05);
    const second = sampleCampaignTypewriterPose(0.15);
    const later = sampleCampaignTypewriterPose(1.05);

    assert.notEqual(first.leftArmPitch, first.rightArmPitch);
    assert.notEqual(second.leftArmPitch, second.rightArmPitch);
    assert.notEqual(first.leftArmPitch, second.leftArmPitch);
    assert.notEqual(first.carriageOffsetM, later.carriageOffsetM);
    assert.ok(first.torsoPitch > 0, 'the typist leans toward the keys');
});

test('a seated actor only ever sinks onto his support, never floats above it', () => {
    assert.equal(
        campaignSeatedActorOffsetY({ activityType: 'typewriter', seatHeightM: 0.45, legHeightM: 0.72 }),
        0.45 - 0.72,
    );
    // Unchanged for typists without an authored seat, and for everyone else.
    assert.equal(campaignSeatedActorOffsetY({ activityType: 'typewriter', legHeightM: 0.72 }), 0);
    assert.equal(campaignSeatedActorOffsetY({ activityType: 'patrol', seatHeightM: 0.4, legHeightM: 0.72 }), 0);
    assert.equal(campaignSeatedActorOffsetY({ activityType: 'fishing' }), 0, 'no dimensions, no drop');

    const quayEdge = campaignSeatedActorOffsetY({ activityType: 'fishing', legHeightM: 0.72 });
    assert.ok(quayEdge < 0, 'the fisherman drops onto the quay edge');
    assert.equal(quayEdge, CAMPAIGN_FISHING_DEFAULTS.seatHeightM - 0.72);
    assert.equal(
        campaignSeatedActorOffsetY({ activityType: 'fishing', seatHeightM: 9, legHeightM: 0.72 }),
        0,
        'an absurd authored seat cannot lift the actor off the ground',
    );
});

test('the fishing grip sits in the seated hands', () => {
    const person = createPersonMesh({ kind: 'male' });
    animatePersonSit(person, 1);
    const arm = person.userData.walkLimbs.arms.find(entry => entry.side > 0).mesh;
    arm.updateWorldMatrix(true, false);
    // The far end of the seated forearm cylinder is where the rod is held.
    const hand = new THREE.Vector3(0, -0.5, 0).applyMatrix4(arm.matrixWorld);
    const anchor = campaignFishingGripAnchor(person.userData.personDimensions);
    assert.ok(Math.abs(anchor.y - hand.y) < 1e-6, `grip y ${anchor.y} vs hand ${hand.y}`);
    assert.ok(Math.abs(anchor.z - hand.z) < 1e-6, `grip z ${anchor.z} vs hand ${hand.z}`);
    assert.ok(anchor.z > 0.3, 'the hands are out in front of the seated torso');
    assert.ok(Math.abs(anchor.x) < Math.abs(hand.x), 'the rod is held between the hands');
    disposePersonMeshSessionCaches();
});

test('the fishing rod bobs within a few degrees on a bounded, repeating cycle', () => {
    // Absolute ceilings, not the module's own constants: idle motion is "a few
    // degrees", so a retuned amplitude that starts casting has to fail here.
    const rest = 35 * Math.PI / 180;
    const bob = 4 * Math.PI / 180;
    let sawUp = false;
    let sawDown = false;
    for (let tS = 0; tS <= 12; tS += 0.05) {
        const pose = fishingPose(tS);
        assert.ok(
            Math.abs(pose.rodPitch - rest) <= bob,
            `rod pitch ${pose.rodPitch} left the few-degree idle band`,
        );
        assert.ok(Math.abs(pose.rodYaw) <= 2 * Math.PI / 180, `rod yaw ${pose.rodYaw}`);
        if (pose.rodPitch > rest + bob * 0.6) sawUp = true;
        if (pose.rodPitch < rest - bob * 0.6) sawDown = true;
    }
    assert.ok(sawUp && sawDown, 'the rod actually moves through the whole band');

    const period = 1 / CAMPAIGN_FISHING_DEFAULTS.rodBobHz;
    assert.ok(
        Math.abs(fishingPose(1.3).rodPitch - fishingPose(1.3 + period).rodPitch) < 1e-9,
        'the rod bob repeats on its authored period',
    );
    assert.deepEqual(fishingPose(2.4), fishingPose(2.4), 'the sample is deterministic');
    assert.notDeepEqual(fishingPose(2.4), fishingPose(2.9));
});

test('the float rides the water plane below the quay, ahead of the rod tip', () => {
    const seatOffsetY = campaignSeatedActorOffsetY({ activityType: 'fishing', legHeightM: MALE_DIMS.legH });
    const waterY = -seatOffsetY - CAMPAIGN_FISHING_DEFAULTS.waterDropM;
    const anchor = campaignFishingGripAnchor(MALE_DIMS);
    for (let tS = 0; tS <= 12; tS += 0.05) {
        const pose = fishingPose(tS);
        assert.equal(pose.seatOffsetY, seatOffsetY);
        assert.ok(
            Math.abs(pose.floatY - waterY) <= 0.08,
            `float y ${pose.floatY} left the water`,
        );
        assert.equal(pose.floatZ, CAMPAIGN_FISHING_DEFAULTS.castDistanceM);
        assert.ok(Math.abs(pose.floatX) <= 0.06 + 1e-9);
        assert.ok(pose.tipY > anchor.y, 'the rod points up');
        assert.ok(pose.tipZ > anchor.z, 'and forward, over the water');
        assert.ok(pose.floatZ > pose.tipZ, 'the float lands beyond the tip');
        const tipReach = Math.hypot(pose.tipX - anchor.x, pose.tipY - anchor.y, pose.tipZ - anchor.z);
        assert.ok(Math.abs(tipReach - CAMPAIGN_FISHING_ROD_TIP_REACH_M) < 1e-9, `rod reach ${tipReach}`);
    }

    const deep = fishingPose(0, { waterDropM: 2.4 });
    assert.ok(Math.abs(deep.floatY - (-seatOffsetY - 2.4)) < 1e-9, 'an authored drop moves the water');
    assert.equal(fishingPose(0, { castDistanceM: 4 }).floatZ, 4);
});

// The world layer copies rodPitch/rodYaw onto a YXZ pivot; this locks the tip
// the pure sample reports against the tip three.js actually produces.
test('the reported rod tip matches the pivot rotation the world layer applies', () => {
    const pose = fishingPose(1.7);
    const anchor = campaignFishingGripAnchor(MALE_DIMS);
    const pivot = new THREE.Object3D();
    pivot.rotation.order = 'YXZ';
    pivot.position.set(anchor.x, anchor.y, anchor.z);
    pivot.rotation.set(Math.PI * 0.5 - pose.rodPitch, pose.rodYaw, 0);
    pivot.updateWorldMatrix(true, false);
    const tip = new THREE.Vector3(0, CAMPAIGN_FISHING_ROD_TIP_REACH_M, 0).applyMatrix4(pivot.matrixWorld);
    assert.ok(Math.abs(tip.x - pose.tipX) < 1e-9, `tip x ${tip.x} vs ${pose.tipX}`);
    assert.ok(Math.abs(tip.y - pose.tipY) < 1e-9, `tip y ${tip.y} vs ${pose.tipY}`);
    assert.ok(Math.abs(tip.z - pose.tipZ) < 1e-9, `tip z ${tip.z} vs ${pose.tipZ}`);
});

test('the fishing heading matches the actor placement convention', () => {
    const heading = fishingPose(0, { headingDeg: 285 }).headingRad;
    assert.ok(Math.abs(heading - (Math.PI - 285 * Math.PI / 180)) < 1e-12, `heading ${heading}`);
    assert.equal(fishingPose(0).headingRad, null);
});
