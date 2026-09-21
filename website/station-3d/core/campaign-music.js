// Pure rules for the campaign music bed: which looping track the persisted
// 'toranj-music' world-effect stage asks for, and whether a world-effect change
// means play, stop or nothing. The Web Audio player in world/campaign-music.js
// only executes these decisions, so the whole contract is unit-testable.

export const MUSIC_SILENCE_STAGE = 'silence';

// The stage string under the spec's effect id, or null when the event does not
// carry the key at all.
export function musicStageForEffects(spec, worldEffects) {
    const stage = worldEffects?.[spec?.effectId];
    return typeof stage === 'string' && stage ? stage : null;
}

// Absent key → null: a cinematic keyframe's transient effects never carry the
// music key and must not stop the bed, and a save without the key leaves
// whatever plays alone. The same track again → null, so a scene change inside
// one mood never restarts the loop. 'silence' stops a playing bed. A stage the
// spec does not know returns { type: 'unknown' } so the player can warn once
// instead of going quiet without a trace.
export function reduceMusicCommand(currentTrackId, detail, spec) {
    const stage = musicStageForEffects(spec, detail?.worldEffects);
    if (stage === null) return null;
    if (stage === MUSIC_SILENCE_STAGE) return currentTrackId ? { type: 'stop' } : null;
    if (!spec?.tracks?.[stage]) return { type: 'unknown', stage };
    if (stage === currentTrackId) return null;
    return { type: 'play', trackId: stage };
}

// Gain ramps for a crossfade on the audio clock. The outgoing bed and the
// incoming one overlap, so a chapter change is a blend rather than a gap.
export function crossfadeEnvelope(nowS, spec) {
    const fadeInS = Math.max(0.05, Number(spec?.fadeInS) || 0);
    const fadeOutS = Math.max(0.05, Number(spec?.fadeOutS) || 0);
    return {
        fadeInEndS: nowS + fadeInS,
        fadeOutEndS: nowS + fadeOutS,
    };
}
