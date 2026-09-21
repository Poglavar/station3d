// Looping emergency-vehicle sirens. One pre-decoded buffer per livery
// (police / ambulance), one looping AudioBufferSourceNode per audible
// vehicle. The cars layer calls updateSirens() each frame with the
// current set of (key, livery, distance) tuples; this module starts
// missing sources, stops sources whose key dropped out, and updates
// gain on survivors.
//
// To swap the actual sound, replace the MP3s at:
//   website/station-3d/audio/sfx/siren/police.mp3
//   website/station-3d/audio/sfx/siren/ambulance.mp3
// (manifest is not used for these — the URLs are hard-coded below.)

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const SIREN_URLS = {
    police: station3dAssetUrl('audio/sfx/siren/police.mp3'),
    ambulance: station3dAssetUrl('audio/sfx/siren/ambulance.mp3'),
};
const AUDIBLE_M    = 280;        // attenuates to 0 past this distance
const SIREN_REF_M  = 12;         // inverse-square reference distance — gain plateaus below this
const MAX_VOICES   = 3;          // cap concurrent sirens — prefer closest
const MAX_GAIN     = 0.55;       // master scale per voice

let ctx = null;
const buffers = { police: null, ambulance: null };
let loadStarted = false;
let unlockCancel = null;

// Map<key, { source, gain, livery }>. Key is the car object ref.
const liveVoices = new Map();

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

function queueSirenInit() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        startLoadingBuffers();
    });
}

function startLoadingBuffers() {
    if (loadStarted) return;
    const c = ensureCtx();
    if (!c) {
        queueSirenInit();
        return;
    }
    loadStarted = true;
    for (const livery of Object.keys(SIREN_URLS)) {
        fetch(SIREN_URLS[livery])
            .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`siren fetch ${r.status}`)))
            .then(ab => c.decodeAudioData(ab))
            .then(buf => { buffers[livery] = buf; })
            .catch(err => console.warn('[siren-sfx] load failed:', livery, err.message));
    }
}

export function preloadSirens() {
    bindGlobalAudioUnlock();
    startLoadingBuffers();
}

function startVoice(key, livery) {
    const c = ensureCtx();
    if (!c) return null;
    const buf = buffers[livery];
    if (!buf) return null;
    resumeUnlockedAudioContext(c);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(g).connect(getAudioDestination(c));
    src.start();
    return { source: src, gain: g, livery };
}

function stopVoice(voice) {
    try {
        // Quick fade so abrupt stop doesn't click.
        const t = ctx.currentTime;
        voice.gain.gain.cancelScheduledValues(t);
        voice.gain.gain.setTargetAtTime(0, t, 0.04);
        voice.source.stop(t + 0.15);
    } catch (_) { /* ignore */ }
    try { voice.source.disconnect(); voice.gain.disconnect(); } catch (_) {}
}

// activeList: Array<{ key, livery, distanceM }>. Keys not present in this
// frame's list are stopped; new keys are started; survivors get gain
// updated by distance attenuation. Voices beyond MAX_VOICES (sorted by
// distance) are stopped to keep the mix clean.
export function updateSirens(activeList) {
    if (!ctx && !ensureCtx()) {
        queueSirenInit();
        return;
    }

    // Pick the MAX_VOICES nearest entries — anything further is silent.
    const sorted = activeList
        .filter(e => e.distanceM <= AUDIBLE_M)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, MAX_VOICES);
    const wantKeys = new Set(sorted.map(e => e.key));

    // Stop voices whose key dropped out.
    for (const [key, voice] of liveVoices) {
        if (!wantKeys.has(key)) {
            stopVoice(voice);
            liveVoices.delete(key);
        }
    }

    // Start / update survivors.
    for (const e of sorted) {
        let voice = liveVoices.get(e.key);
        if (!voice) {
            voice = startVoice(e.key, e.livery);
            if (!voice) continue;     // buffer not decoded yet
            liveVoices.set(e.key, voice);
        }
        // Inverse-square attenuation with a near-field reference (no
        // boost below REF_M) and a linear hard fade to 0 at AUDIBLE_M
        // so the curve doesn't stay audible at the edge. Linear falloff
        // (the previous version) read as "no attenuation" because gain
        // was still ~0.5 at 140 m.
        const d = Math.max(SIREN_REF_M, e.distanceM);
        const inv = (SIREN_REF_M / d) * (SIREN_REF_M / d);
        const fade = Math.max(0, 1 - e.distanceM / AUDIBLE_M);
        const att = inv * fade;
        voice.gain.gain.setTargetAtTime(att * MAX_GAIN, ctx.currentTime, 0.08);
    }
}

export function stopAllSirens() {
    for (const voice of liveVoices.values()) stopVoice(voice);
    liveVoices.clear();
}
