// Recorded fireworks clips (CC0 — see audio/sfx/fireworks/SOURCES.md): rocket
// whistles, aerial bursts and crackle tails. Same shape as bird-sfx: decoded
// once into Web Audio buffers, every playback through gain + rate + pan, and
// a start offset so a burst 300 m away booms after its flash, not with it.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

export const FIREWORKS_SFX_FILES = Object.freeze({
    launch: Object.freeze([
        station3dAssetUrl('audio/sfx/fireworks/launch-1.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/launch-2.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/launch-3.mp3'),
    ]),
    burst: Object.freeze([
        station3dAssetUrl('audio/sfx/fireworks/burst-1.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/burst-2.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/burst-3.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/burst-4.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/burst-5.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/burst-6.mp3'),
    ]),
    crackle: Object.freeze([
        station3dAssetUrl('audio/sfx/fireworks/crackle-1.mp3'),
        station3dAssetUrl('audio/sfx/fireworks/crackle-2.mp3'),
    ]),
});

const MAX_DELAY_S = 4;

let ctx = null;
const buffersByKind = new Map();    // kind → AudioBuffer[], sparse while loading
const loadStartedKinds = new Set();
const loadWantedKinds = new Set();  // asked for before the audio unlock
let unlockCancel = null;

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

export function fireworksClipCount(kind) {
    return (FIREWORKS_SFX_FILES[kind] || []).length;
}

function startLoadingBuffers(kind) {
    const files = FIREWORKS_SFX_FILES[kind];
    if (!files || loadStartedKinds.has(kind)) return;
    const c = ensureCtx();
    if (!c) {
        bindGlobalAudioUnlock();
        if (!unlockCancel) {
            unlockCancel = whenAudioUnlocked(() => {
                unlockCancel = null;
                for (const pending of loadWantedKinds) startLoadingBuffers(pending);
            });
        }
        loadWantedKinds.add(kind);
        return;
    }
    loadStartedKinds.add(kind);
    const buffers = [];
    buffersByKind.set(kind, buffers);
    files.forEach((url, index) => {
        fetch(url)
            .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`fireworks fetch ${r.status}`))))
            .then(ab => c.decodeAudioData(ab))
            .then(buf => { buffers[index] = buf; })
            .catch(err => console.warn('[fireworks-sfx] load failed:', url, err.message));
    });
}

// Fetch + decode every clip kind so the first rocket is not silent.
export function preloadFireworksSfx() {
    bindGlobalAudioUnlock();
    for (const kind of Object.keys(FIREWORKS_SFX_FILES)) startLoadingBuffers(kind);
}

// Builds the playback graph for one clip on any AudioContext-shaped object;
// exported so the schedule can be asserted without a browser.
export function scheduleFireworkClip(c, destination, buffer, {
    delayS = 0,
    gain = 0.4,
    playbackRate = 1,
    pan = 0,
} = {}) {
    if (!c || !destination || !buffer) return null;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.max(0.6, Math.min(1.6, Number(playbackRate) || 1));
    const g = c.createGain();
    g.gain.value = Math.max(0, Math.min(1, Number(gain) || 0));
    let tail = g;
    // Older Safari has no StereoPannerNode; the burst is simply centred there.
    if (typeof c.createStereoPanner === 'function') {
        const panner = c.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, Number(pan) || 0));
        tail = g.connect(panner);
    }
    src.connect(g);
    tail.connect(destination);
    const startAt = (Number(c.currentTime) || 0) + Math.max(0, Math.min(MAX_DELAY_S, Number(delayS) || 0));
    src.start(startAt);
    return { source: src, startAt };
}

// Plays one clip of `kind`. Drops the call silently when nothing has decoded
// yet: a rocket that goes up before the buffers arrive is simply a quiet one.
export function playFireworkSound(kind, { clipIndex = 0, ...options } = {}) {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    if (!loadStartedKinds.has(kind)) startLoadingBuffers(kind);
    const ready = (buffersByKind.get(kind) || []).filter(Boolean);
    if (ready.length === 0) return false;
    const buffer = ready[Math.abs(Math.floor(clipIndex)) % ready.length];
    return scheduleFireworkClip(c, getAudioDestination(c), buffer, options) !== null;
}
