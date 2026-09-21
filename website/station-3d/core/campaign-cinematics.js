// Samples declarative geographic cinematic tracks from elapsed time. Skip and
// normal completion share the same canonical endpoint contract.

import { finiteOrNull } from './math.js';

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

export const CINEMATIC_FADE_IN_MS = 900;
const CINEMATIC_FADE_OUT_MS = 1050;
const CINEMATIC_SHOT_FADE_HALF_MS = 360;
const CINEMATIC_REDUCED_FADE_MS = 180;

function eased(value, easing) {
    const t = clamp01(value);
    if (easing === 'ease-in') return t * t;
    if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
    if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    return t;
}

function interpolateNumber(a, b, ratio) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left)) return Number.isFinite(right) ? right : null;
    if (!Number.isFinite(right)) return left;
    return left + (right - left) * ratio;
}

// A camera point is geographic (lat/lon/heightM) or, on a player-relative
// shot, an offset in the subject's own frame (rightM/upM/forwardM). Both
// interpolate field by field.
function interpolatePose(left, right, ratio) {
    if (!left && !right) return null;
    const a = left || right;
    const b = right || left;
    const pose = {
        lat: interpolateNumber(a.lat, b.lat, ratio),
        lon: interpolateNumber(a.lon, b.lon, ratio),
        heightM: interpolateNumber(a.heightM, b.heightM, ratio),
    };
    for (const key of ['rightM', 'upM', 'forwardM']) {
        const value = interpolateNumber(a[key], b[key], ratio);
        if (value !== null) pose[key] = value;
    }
    return pose;
}

function activeCaption(track, elapsedMs) {
    return (track.captions || []).find(caption => (
        elapsedMs >= Number(caption.startMs || 0)
        && elapsedMs < Number(caption.endMs ?? track.durationMs)
    )) || null;
}

function activeArtwork(track, elapsedMs) {
    const artwork = track.artwork;
    if (!artwork) return null;
    const startMs = Math.max(0, finiteOrNull(artwork.startMs) ?? 0);
    const endMs = finiteOrNull(artwork.endMs)
        ?? finiteOrNull(track.durationMs)
        ?? 0;
    return elapsedMs >= startMs && elapsedMs < endMs ? artwork : null;
}

// How a film or gameplay caption reads on screen. Plain narration is its text.
// A caption spoken by a character names the speaker as a label before a quoted
// line ("VIKI: „Naš grad.“"), so the name is never part of the spoken text and
// the character's own voice reads the quote; a stage cue ("[EKSPLOZIJA]") is
// shown in front and never spoken either.
export function formatCaptionText(caption, language = 'hr') {
    const pick = value => (value && typeof value === 'object'
        ? (value[language] ?? value.hr ?? value.en ?? '')
        : (value ?? ''));
    const text = String(pick(caption?.text) || '').trim();
    if (!text) return '';
    const cue = String(pick(caption?.cue) || '').trim();
    const label = String(pick(caption?.label) || '').trim();
    const quoted = label ? (language === 'hr' ? `„${text}“` : `“${text}”`) : text;
    return `${cue ? `[${cue}] ` : ''}${label ? `${label}: ` : ''}${quoted}`;
}

export function sampleCinematic(track, elapsedMs, { reducedMotion = false } = {}) {
    const time = Math.max(0, Math.min(Number(track.durationMs) || 0, Number(elapsedMs) || 0));
    const keyframes = [...(track.keyframes || [])].sort((a, b) => a.atMs - b.atMs);
    if (keyframes.length === 0) return { done: true, elapsedMs: time, camera: null, caption: null };
    let left = keyframes[0];
    let right = keyframes.at(-1);
    for (let index = 0; index < keyframes.length - 1; index += 1) {
        if (time <= keyframes[index + 1].atMs) {
            left = keyframes[index];
            right = keyframes[index + 1];
            break;
        }
    }
    const span = Math.max(1, Number(right.atMs) - Number(left.atMs));
    const rawRatio = clamp01((time - Number(left.atMs)) / span);
    const ratio = reducedMotion ? (rawRatio < 0.85 ? 0 : 1) : eased(rawRatio, right.easing);
    const discreteFrame = rawRatio >= 1 ? right : left;
    // A geographic shot and a player-relative one never blend: metres beside
    // an aircraft and degrees on the globe are not the same numbers. Such a
    // pair is a cut, so the discrete frame's camera holds across the span.
    const blend = !(left.camera && right.camera
        && (left.camera.relativeTo || null) !== (right.camera.relativeTo || null));
    const cameraLeft = blend ? left.camera : discreteFrame.camera;
    const cameraRight = blend ? right.camera : discreteFrame.camera;
    return {
        done: time >= Number(track.durationMs),
        elapsedMs: time,
        progress: Number(track.durationMs) > 0 ? time / Number(track.durationMs) : 1,
        camera: {
            relativeTo: (cameraRight?.relativeTo ?? cameraLeft?.relativeTo) || null,
            position: interpolatePose(cameraLeft?.position, cameraRight?.position, ratio),
            lookAt: interpolatePose(cameraLeft?.lookAt, cameraRight?.lookAt, ratio),
            fovDeg: interpolateNumber(cameraLeft?.fovDeg, cameraRight?.fovDeg, ratio),
        },
        caption: activeCaption(track, time),
        artwork: activeArtwork(track, time),
        worldEffects: discreteFrame.worldEffects
            ? JSON.parse(JSON.stringify(discreteFrame.worldEffects))
            : null,
    };
}

// Presentation sampling stays pure so the DOM layer only paints one opacity
// and one shot index each frame. Mid-film fades mask the handoff between
// authored camera moves; reduced motion moves that mask to the instant where
// sampleCinematic switches between its held camera poses.
export function cinematicPresentationTransitions(track, { reducedMotion = false } = {}) {
    const durationMs = Math.max(0, finiteOrNull(track?.durationMs) ?? 0);
    const keyframes = [...(track?.keyframes || [])]
        .filter(frame => finiteOrNull(frame?.atMs) != null)
        .sort((a, b) => finiteOrNull(a.atMs) - finiteOrNull(b.atMs));
    const transitionTimes = [];
    for (let index = 1; index < keyframes.length; index += 1) {
        // A keyframe can advance a world effect without changing the shot.
        // Treating those beats as camera cuts darkens the very action they are
        // meant to reveal (explosions and collapses in particular). Authors
        // opt those state-only transitions out of the blackout explicitly.
        if (keyframes[index].maskTransition === false) continue;
        const leftMs = finiteOrNull(keyframes[index - 1].atMs);
        const rightMs = finiteOrNull(keyframes[index].atMs);
        if (rightMs <= 0 || rightMs >= durationMs) continue;
        transitionTimes.push(reducedMotion
            ? leftMs + (rightMs - leftMs) * 0.85
            : rightMs);
    }
    return transitionTimes;
}

// Readout holds stop before the next cut starts darkening the current shot.
// Caption boundaries can stop earlier than a camera transition.
export function cinematicReadoutHoldTime(track, startMs, endMs, { reducedMotion = false } = {}) {
    const durationMs = Math.max(0, finiteOrNull(track?.durationMs) ?? 0);
    const shotHalfMs = reducedMotion ? CINEMATIC_REDUCED_FADE_MS : CINEMATIC_SHOT_FADE_HALF_MS;
    const endFadeMs = reducedMotion ? CINEMATIC_REDUCED_FADE_MS : CINEMATIC_FADE_OUT_MS;
    const cut = cinematicPresentationTransitions(track, { reducedMotion }).find(time => time > startMs);
    return Math.max(startMs, Math.min(
        endMs - 1,
        durationMs - endFadeMs,
        cut == null ? Infinity : cut - shotHalfMs,
    ));
}

export function sampleCinematicPresentation(
    track,
    elapsedMs,
    { reducedMotion = false } = {},
) {
    const durationMs = Math.max(0, finiteOrNull(track?.durationMs) ?? 0);
    const time = Math.max(0, Math.min(durationMs, finiteOrNull(elapsedMs) ?? 0));
    const transitionTimes = cinematicPresentationTransitions(track, { reducedMotion });

    let shotIndex = 0;
    for (const transitionMs of transitionTimes) {
        if (time >= transitionMs) shotIndex += 1;
    }

    const edgeFadeMs = reducedMotion ? CINEMATIC_REDUCED_FADE_MS : CINEMATIC_FADE_IN_MS;
    const endFadeMs = reducedMotion ? CINEMATIC_REDUCED_FADE_MS : CINEMATIC_FADE_OUT_MS;
    const shotHalfMs = reducedMotion
        ? CINEMATIC_REDUCED_FADE_MS
        : CINEMATIC_SHOT_FADE_HALF_MS;
    const introOpacity = edgeFadeMs > 0 ? 1 - clamp01(time / edgeFadeMs) : 0;
    const outroOpacity = endFadeMs > 0
        ? clamp01((time - Math.max(0, durationMs - endFadeMs)) / endFadeMs)
        : 0;
    let shotOpacity = 0;
    for (const transitionMs of transitionTimes) {
        const distanceMs = Math.abs(time - transitionMs);
        if (distanceMs > shotHalfMs) continue;
        shotOpacity = Math.max(
            shotOpacity,
            (1 - distanceMs / shotHalfMs) * (reducedMotion ? 0.9 : 0.72),
        );
    }

    return {
        curtainOpacity: clamp01(Math.max(introOpacity, outroOpacity, shotOpacity)),
        shotIndex,
    };
}

// The subject a player-relative shot is framed on: the pose the frame owner
// hands the cinematic each frame. A vehicle pose rides `gtaPose`; scene x/y/z
// and the scene yaw (forward = (sin yaw, cos yaw)) are all a shot needs.
export function cinematicSubjectFromPose(pose) {
    const source = pose?.gtaPose || pose;
    const x = finiteOrNull(source?.x);
    const y = finiteOrNull(source?.y);
    const z = finiteOrNull(source?.z);
    const heading = finiteOrNull(source?.heading);
    if (x === null || y === null || z === null || heading === null) return null;
    return { x, y, z, heading };
}

// Resolves a player-relative camera into scene coordinates: right/up/forward
// metres in the subject's frame become x/y/z beside the actual aircraft, so a
// shot authored once frames the plane wherever a spawn or a checkpoint put it.
export function resolveRelativeCinematicCamera(camera, subject) {
    if (camera?.relativeTo !== 'player' || !subject || !camera.position || !camera.lookAt) return null;
    const forwardX = Math.sin(subject.heading);
    const forwardZ = Math.cos(subject.heading);
    // right = forward × up in the scene's right-handed frame
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const place = (offset) => {
        const right = finiteOrNull(offset.rightM) ?? 0;
        const up = finiteOrNull(offset.upM) ?? 0;
        const forward = finiteOrNull(offset.forwardM) ?? 0;
        return {
            x: subject.x + rightX * right + forwardX * forward,
            y: subject.y + up,
            z: subject.z + rightZ * right + forwardZ * forward,
        };
    };
    return {
        position: place(camera.position),
        lookAt: place(camera.lookAt),
        fovDeg: finiteOrNull(camera.fovDeg),
    };
}

export function cinematicCanonicalEndpoint(track) {
    const last = [...(track?.keyframes || [])].sort((a, b) => a.atMs - b.atMs).at(-1) || null;
    return {
        camera: last?.camera || null,
        endpoint: JSON.parse(JSON.stringify(track?.endpoint || {})),
    };
}

export function finishCinematic(track, { skipped = false } = {}) {
    return {
        cinematicId: track.id,
        skipped: !!skipped,
        ...cinematicCanonicalEndpoint(track),
    };
}
