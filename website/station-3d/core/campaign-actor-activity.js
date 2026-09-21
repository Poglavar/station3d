// Pure motion samples for authored background work. The world layer owns the
// meshes; campaign content only describes patrol routes and desk activities.

import { DEG_TO_RAD, finiteOrNull } from './math.js';

function finite(value, fallback = 0) {
    return finiteOrNull(value) ?? fallback;
}

function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

export function stepCampaignActorPatrol({
    actorX,
    actorZ,
    targetX,
    targetZ,
    speedMps = 0.72,
    dt,
} = {}) {
    const x = finite(actorX);
    const z = finite(actorZ);
    const tx = finite(targetX, x);
    const tz = finite(targetZ, z);
    const dx = tx - x;
    const dz = tz - z;
    const distanceM = Math.hypot(dx, dz);
    if (distanceM <= 1e-6) {
        return { x: tx, z: tz, heading: 0, walking: false, arrived: true };
    }
    const stepM = Math.min(
        distanceM,
        Math.max(0, finite(speedMps, 0.72)) * Math.max(0, finite(dt)),
    );
    return {
        x: x + dx / distanceM * stepM,
        z: z + dz / distanceM * stepM,
        heading: Math.atan2(dx, dz),
        walking: stepM > 0,
        arrived: distanceM - stepM <= 1e-6,
    };
}

export function sampleCampaignTypewriterPose(elapsedSeconds, phaseOffsetSeconds = 0) {
    const elapsed = Math.max(0, finite(elapsedSeconds));
    const phase = elapsed + finite(phaseOffsetSeconds);
    const leftStroke = (Math.sin(phase * 19) + 1) * 0.5;
    const rightStroke = (Math.sin(phase * 19 + Math.PI) + 1) * 0.5;
    const lineProgress = positiveModulo(phase * 0.19, 1);
    return {
        leftArmPitch: -0.93 - leftStroke * 0.16,
        rightArmPitch: -0.93 - rightStroke * 0.16,
        leftArmRoll: 0.08 + leftStroke * 0.05,
        rightArmRoll: -0.08 - rightStroke * 0.05,
        torsoPitch: 0.045 + Math.sin(phase * 2.1) * 0.012,
        carriageOffsetM: 0.34 - lineProgress * 0.68,
        keyTravelM: Math.max(leftStroke, rightStroke) * 0.012,
    };
}

// Authored fishing. The actor sits on the quay edge, so the mesh origin drops by
// nearly a leg length and everything else is expressed in that seated local
// frame: +Z is the direction the actor faces, y = 0 is the mesh origin and the
// quay surface sits at -seatOffsetY above it.
export const CAMPAIGN_FISHING_ROD_LENGTH_M = 2.2;
// The butt sticks out behind the hands, so the line hangs from a little less
// than the rod's full length ahead of the grip.
export const CAMPAIGN_FISHING_ROD_BUTT_M = 0.28;
export const CAMPAIGN_FISHING_ROD_TIP_REACH_M
    = CAMPAIGN_FISHING_ROD_LENGTH_M - CAMPAIGN_FISHING_ROD_BUTT_M;

// Mirrors the seated arm pitch animatePersonSit() applies in person-mesh.js, so
// the grip lands in the hands rather than beside them.
const SEATED_ARM_PITCH_RAD = -0.92;

export const CAMPAIGN_FISHING_DEFAULTS = Object.freeze({
    seatHeightM: 0.06,
    castDistanceM: 2.5,
    waterDropM: 1.1,
    rodPitchDeg: 35,
    rodBobDeg: 3,
    rodBobHz: 0.4,
    rodYawDeg: 1.6,
    floatBobM: 0.05,
    floatBobHz: 0.31,
});

/**
 * How far a seated actor's mesh origin drops so the hips land on the seat: the
 * chair for a typist, the quay edge for a fisherman. Never positive, so a seated
 * actor can only sink into his support, never float above the sampled ground.
 */
export function campaignSeatedActorOffsetY({
    activityType,
    seatHeightM,
    legHeightM,
} = {}) {
    const legH = finiteOrNull(legHeightM);
    if (legH === null) return 0;
    const seat = finiteOrNull(seatHeightM);
    if (activityType === 'typewriter') {
        return seat === null ? 0 : Math.min(0, seat - legH);
    }
    if (activityType === 'fishing') {
        return Math.min(0, (seat ?? CAMPAIGN_FISHING_DEFAULTS.seatHeightM) - legH);
    }
    return 0;
}

/** Where the seated hands meet, in the person mesh's local frame. */
export function campaignFishingGripAnchor(dimensions = {}, armPitchRad = SEATED_ARM_PITCH_RAD) {
    const legH = finite(dimensions?.legH, 0.72);
    const bodyH = finite(dimensions?.bodyH, 0.76);
    const armH = finite(dimensions?.armH, 0.6);
    const armX = finite(dimensions?.armX, 0.2);
    const shoulderY = legH + bodyH * 0.52 + armH * 0.5;
    return {
        x: armX * 0.5,
        y: shoulderY - Math.cos(armPitchRad) * armH,
        z: -Math.sin(armPitchRad) * armH,
    };
}

/**
 * One frame of the fisherman: a slow rod bob, a drifting float, and the rod tip
 * the line hangs from. All lengths are metres in the seated person's local
 * frame; the caller only copies them onto meshes.
 */
export function sampleCampaignFishingPose({
    tS = 0,
    headingDeg = null,
    dimensions = null,
    seatHeightM = null,
    castDistanceM = null,
    waterDropM = null,
    rodPitchDeg = null,
    phaseOffsetSeconds = 0,
} = {}) {
    const defaults = CAMPAIGN_FISHING_DEFAULTS;
    const t = Math.max(0, finite(tS)) + finite(phaseOffsetSeconds);
    const seatOffsetY = campaignSeatedActorOffsetY({
        activityType: 'fishing',
        seatHeightM,
        legHeightM: dimensions?.legH,
    });
    const rodBob = Math.sin(t * defaults.rodBobHz * Math.PI * 2);
    const pitch = (finiteOrNull(rodPitchDeg) ?? defaults.rodPitchDeg) * DEG_TO_RAD
        + rodBob * defaults.rodBobDeg * DEG_TO_RAD;
    const yaw = Math.sin(t * defaults.rodBobHz * Math.PI * 2 * 0.37)
        * defaults.rodYawDeg * DEG_TO_RAD;
    const anchor = campaignFishingGripAnchor(dimensions || {});
    const reach = Math.cos(pitch) * CAMPAIGN_FISHING_ROD_TIP_REACH_M;
    const cast = Math.max(0.2, finiteOrNull(castDistanceM) ?? defaults.castDistanceM);
    const waterY = -seatOffsetY - Math.max(0, finiteOrNull(waterDropM) ?? defaults.waterDropM);
    const floatBob = Math.sin(t * defaults.floatBobHz * Math.PI * 2) * defaults.floatBobM;
    const heading = finiteOrNull(headingDeg);
    return {
        headingRad: heading === null ? null : Math.PI - heading * DEG_TO_RAD,
        seatOffsetY,
        rodPitch: pitch,
        rodYaw: yaw,
        torsoPitch: 0.05 + rodBob * 0.012,
        tipX: anchor.x + reach * Math.sin(yaw),
        tipY: anchor.y + Math.sin(pitch) * CAMPAIGN_FISHING_ROD_TIP_REACH_M,
        tipZ: anchor.z + reach * Math.cos(yaw),
        floatX: Math.sin(t * defaults.floatBobHz * Math.PI * 2 * 0.61) * 0.06,
        floatY: waterY + floatBob,
        floatZ: cast,
    };
}
