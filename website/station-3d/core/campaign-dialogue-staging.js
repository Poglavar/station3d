// Resolves a physical campaign speaker and composes bounded ground-relative
// camera shots for dialogue. It stays DOM/THREE-free so shot direction and
// reduced-motion cuts can be tested without launching the renderer.

import { campaignSeatedActorOffsetY } from './campaign-actor-activity.js';
import {
    DEG_TO_RAD,
    finiteOrNull,
    geoToLocal,
    localToGeo,
} from './math.js';

const MIN_PLAYER_DIRECTION_M = 0.45;
// A remote checkpoint pose is not a useful eyeline for an actor inside an
// authored set piece. Beyond conversational range, stage the shot from the
// actor's authored facing instead of placing the camera through intervening
// walls, vehicles, or scenery.
const MAX_PLAYER_DIRECTION_M = 12;
const CUT_FADE_MS = 260;
// Eyeline of a standing person mesh; the camera sits a little above it and
// looks straight at it, which keeps the face above the dialogue panel.
const STANDING_EYE_HEIGHT_M = 1.48;
const ESTABLISHING_CAMERA_ABOVE_EYE_M = 0.38;
const CLOSE_CAMERA_ABOVE_EYE_M = 0.14;
const DEFAULT_LEG_HEIGHT_M = 0.72;
// Activities that seat the actor: the mesh origin drops by nearly a leg, so
// the eyeline drops with it. Aiming at a standing eyeline put the fisherman's
// cap at the bottom of the frame, under the panel.
const SEATED_ACTIVITY_TYPES = new Set(['fishing', 'typewriter']);
const REDUCED_CUT_FADE_MS = 90;

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

export function campaignDialogueGroundY({
    roomFloorY = null,
    authoredGroundY = null,
    terrainGroundY = null,
} = {}) {
    return finiteOrNull(roomFloorY)
        ?? finiteOrNull(authoredGroundY)
        ?? finiteOrNull(terrainGroundY);
}

export function campaignDialogueSpeakerPlacement(scene, speakerId) {
    const id = String(speakerId || '').trim();
    if (!id) return null;
    const authored = [
        ...(scene?.authored?.actors || []),
        ...(scene?.authored?.preloadedActors || []),
    ].find(actor => actor?.actorId === id);
    const lat = finiteOrNull(authored?.lat);
    const lon = finiteOrNull(authored?.lon);
    if (lat == null || lon == null) return null;
    const activityType = String(authored?.activity?.type || '');
    const seated = SEATED_ACTIVITY_TYPES.has(activityType);
    return {
        actorId: id,
        ...(authored?.support ? { support: authored.support } : {}),
        lat,
        lon,
        headingDeg: finiteOrNull(authored?.headingDeg),
        ...(authored?.dialogueCamera ? { dialogueCamera: authored.dialogueCamera } : {}),
        dialogueElevationM: finiteOrNull(authored?.dialogueElevationM) ?? 0,
        seated,
        eyeHeightM: finiteOrNull(authored?.dialogueEyeHeightM)
            ?? (seated
                ? STANDING_EYE_HEIGHT_M + campaignSeatedActorOffsetY({
                    activityType,
                    seatHeightM: finiteOrNull(authored?.activity?.seatHeightM),
                    legHeightM: DEFAULT_LEG_HEIGHT_M,
                })
                : STANDING_EYE_HEIGHT_M),
    };
}

function directionTowardPlayer(speaker, playerPose) {
    const playerLat = finiteOrNull(playerPose?.lat);
    const playerLon = finiteOrNull(playerPose?.lon);
    if (playerLat != null && playerLon != null) {
        const local = geoToLocal(playerLon, playerLat, speaker.lon, speaker.lat);
        const distanceM = Math.hypot(local.x, local.z);
        if (distanceM >= MIN_PLAYER_DIRECTION_M
            && distanceM <= MAX_PLAYER_DIRECTION_M) {
            return { x: local.x / distanceM, z: local.z / distanceM };
        }
    }
    const heading = (speaker.headingDeg ?? 0) * DEG_TO_RAD;
    return { x: Math.sin(heading), z: -Math.cos(heading) };
}

export function campaignDialogueShot({
    scene,
    speakerId,
    playerPose,
    beatIndex = 0,
} = {}) {
    const speaker = campaignDialogueSpeakerPlacement(scene, speakerId);
    if (!speaker) return null;
    // Stage from the player's side when nearby. The presentation publishes
    // this shot once so the speaker faces its camera, including remote train
    // inspections whose safe camera must use the authored facing instead.
    const toward = directionTowardPlayer(speaker, playerPose);
    const side = { x: -toward.z, z: toward.x };
    const sequence = Math.max(0, Math.trunc(finiteOrNull(beatIndex) ?? 0));
    const establishing = sequence === 0;
    const sideSign = sequence % 2 === 0 ? 1 : -1;
    const distanceM = finiteOrNull(speaker.dialogueCamera?.distanceM) ?? (establishing ? 2.35 : 1.42);
    const sideM = finiteOrNull(speaker.dialogueCamera?.sideM) ?? (establishing ? 0.82 : 0.38) * sideSign;
    const elevationM = speaker.dialogueElevationM;
    const camera = localToGeo(
        toward.x * distanceM + side.x * sideM,
        toward.z * distanceM + side.z * sideM,
        speaker.lon,
        speaker.lat,
    );
    const target = localToGeo(
        toward.x * 0.04,
        toward.z * 0.04,
        speaker.lon,
        speaker.lat,
    );
    return {
        // Lets the renderer ground both sides of the shot to the physical
        // speaker's actual support. Sampling bare terrain independently below
        // the camera and eyeline can aim at a torso when the actor stands on a
        // rail/road formation above it.
        groundReference: {
            ...(speaker.support ? { support: speaker.support } : {}),
            lat: speaker.lat,
            lon: speaker.lon,
        },
        position: {
            lat: camera.lat,
            lon: camera.lon,
            heightM: elevationM + speaker.eyeHeightM
                + (establishing ? ESTABLISHING_CAMERA_ABOVE_EYE_M : CLOSE_CAMERA_ABOVE_EYE_M),
        },
        lookAt: {
            lat: target.lat,
            lon: target.lon,
            heightM: elevationM + speaker.eyeHeightM,
        },
        fovDeg: finiteOrNull(speaker.dialogueCamera?.fovDeg) ?? (establishing ? 52 : 42),
        // The frame owner renders this through the same camera path as a film;
        // the marker keeps a speaker shot from counting as one (a film shows
        // the walker, a dialogue shot must not stand the walker in front of
        // the speaker it frames).
        framing: 'dialogue',
    };
}

export function campaignDialogueCutOpacity(
    elapsedMs,
    { reducedMotion = false } = {},
) {
    const time = Math.max(0, finiteOrNull(elapsedMs) ?? 0);
    const fadeMs = reducedMotion ? REDUCED_CUT_FADE_MS : CUT_FADE_MS;
    return 1 - clamp01(time / fadeMs);
}
