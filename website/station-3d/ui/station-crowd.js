// Station crowd murmur for the cab. When the tram pulls into a stop, a random
// slice of a crowd-babble recording plays for roughly the station's dwell time,
// as boarding/alighting ambience sitting UNDER the PA announcement. One
// recording, sliced at a fresh random offset each stop, so it never reads as the
// same loop and the length tracks the dwell (a longer dwell = a longer clip).
//
// Asset: audio/ambience/station-crowd.mp3 (decoded once, lazily). Mirrors the
// lifecycle of station-pa.js so the cab wires both the same way.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    hasAudioUnlock,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const CROWD_URL = station3dAssetUrl('audio/ambience/station-crowd.mp3');
// Ambience sits under the PA voice (PA is 0.85) and the engine — present, not
// competing.
const CROWD_GAIN = 0.4;
// Fades so a mid-recording slice doesn't click in or out.
const FADE_S = 0.6;
// Clip length tracks the dwell, clamped so a very short/long dwell still sounds
// like a stop rather than a blip or an endless drone.
const MIN_CLIP_S = 3;
const MAX_CLIP_S = 20;
const DEFAULT_DWELL_S = 10;

let ctx = null;
let buffer = null;
let bufferLoading = null;
let lastPausedStationName = null;
let activeSource = null;
let activeGain = null;
let unlockCancel = null;

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

async function loadBuffer() {
    if (buffer) return buffer;
    if (bufferLoading) return bufferLoading;
    const c = ensureCtx();
    if (!c) return null;
    bufferLoading = fetch(CROWD_URL)
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`crowd fetch ${r.status}`)))
        .then(ab => c.decodeAudioData(ab))
        .then(buf => { buffer = buf; return buf; })
        .catch(err => { console.warn('[station-crowd] load failed:', err.message); bufferLoading = null; return null; });
    return bufferLoading;
}

function warmStationCrowdAudio() {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    loadBuffer();
    return true;
}

function queueStationCrowdWarmup() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        warmStationCrowdAudio();
    });
}

function stopActive(immediate) {
    if (!activeSource) return;
    const src = activeSource, g = activeGain;
    activeSource = null; activeGain = null;
    try {
        if (!immediate && ctx && g) {
            const t = ctx.currentTime;
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(g.gain.value, t);
            g.gain.linearRampToValueAtTime(0, t + 0.2);
            src.stop(t + 0.22);
        } else {
            src.stop();
        }
    } catch (_) {}
}

// Play a random dwell-length slice of the crowd recording as arrival ambience.
function playCrowd(dwellSeconds) {
    const c = ensureCtx();
    if (!c) return;
    loadBuffer().then((buf) => {
        if (!buf) return;
        resumeUnlockedAudioContext(c);
        stopActive(true);
        const dur = buf.duration;
        const dwell = Number.isFinite(Number(dwellSeconds)) && Number(dwellSeconds) > 0
            ? Number(dwellSeconds) : DEFAULT_DWELL_S;
        const clip = Math.max(MIN_CLIP_S, Math.min(MAX_CLIP_S, dwell, dur));
        const maxOffset = Math.max(0, dur - clip);
        const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
        const src = c.createBufferSource();
        src.buffer = buf;
        const g = c.createGain();
        // Fade in, hold, fade out across the clip (each fade never exceeds a
        // third of the clip, so short clips still get a clean envelope).
        const t0 = c.currentTime + 0.02;
        const fIn = Math.min(FADE_S, clip / 3);
        const fOut = Math.min(FADE_S, clip / 3);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(CROWD_GAIN, t0 + fIn);
        g.gain.setValueAtTime(CROWD_GAIN, t0 + Math.max(fIn, clip - fOut));
        g.gain.linearRampToValueAtTime(0, t0 + clip);
        src.connect(g).connect(getAudioDestination(c));
        src.start(t0, offset, clip);
        activeSource = src; activeGain = g;
        src.onended = () => {
            if (activeSource === src) { activeSource = null; activeGain = null; }
            try { src.disconnect(); g.disconnect(); } catch (_) {}
        };
    });
}

export function preloadStationCrowd() {
    bindGlobalAudioUnlock();
    if (!warmStationCrowdAudio()) queueStationCrowdWarmup();
    lastPausedStationName = null;
}

export function bindStationCrowdUnlock() {
    bindGlobalAudioUnlock();
    queueStationCrowdWarmup();
}

// Frame hook — same status object that drives the PA (has .paused,
// .stationName when paused, and .dwellRemainingS). Fires once per arrival at a
// new station; resets on departure so the next stop re-triggers.
export function updateStationCrowd(status) {
    if (!status || !hasAudioUnlock()) return;
    if (status.paused && status.stationName) {
        if (status.stationName !== lastPausedStationName) {
            lastPausedStationName = status.stationName;
            playCrowd(status.dwellRemainingS);
        }
        return;
    }
    if (lastPausedStationName != null) lastPausedStationName = null;
}

export function stopStationCrowd() {
    if (unlockCancel) { unlockCancel(); unlockCancel = null; }
    stopActive(true);
    lastPausedStationName = null;
}
