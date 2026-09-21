// Recorded bird calls (public-domain / CC0 — see audio/sfx/birds/SOURCES.md),
// one clip set per species. Same shape as honk-sfx: decoded once into Web
// Audio buffers; each playback goes through gain + playbackRate + stereo pan
// so the caller can make every call sound like a different bird somewhere
// else across the roofs.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const BIRD_FILES = {
    seagull: [
        station3dAssetUrl('audio/sfx/birds/seagull-1.mp3'),
        station3dAssetUrl('audio/sfx/birds/seagull-2.mp3'),
        station3dAssetUrl('audio/sfx/birds/seagull-3.mp3'),
    ],
    crow: [
        station3dAssetUrl('audio/sfx/birds/crow-1.mp3'),
        station3dAssetUrl('audio/sfx/birds/crow-2.mp3'),
    ],
};

let ctx = null;
const buffersBySpecies = new Map();   // species → AudioBuffer[], sparse while loading
const loadStartedSpecies = new Set();
const loadWantedSpecies = new Set();  // asked for before the audio unlock
let unlockCancel = null;

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

export function birdClipCount(species) {
    return (BIRD_FILES[species] || []).length;
}

function startLoadingBuffers(species) {
    const files = BIRD_FILES[species];
    if (!files || loadStartedSpecies.has(species)) return;
    const c = ensureCtx();
    if (!c) {
        bindGlobalAudioUnlock();
        if (!unlockCancel) {
            unlockCancel = whenAudioUnlocked(() => {
                unlockCancel = null;
                for (const pending of loadWantedSpecies) startLoadingBuffers(pending);
            });
        }
        loadWantedSpecies.add(species);
        return;
    }
    loadStartedSpecies.add(species);
    const buffers = [];
    buffersBySpecies.set(species, buffers);
    files.forEach((url, index) => {
        fetch(url)
            .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`bird fetch ${r.status}`))))
            .then(ab => c.decodeAudioData(ab))
            .then(buf => { buffers[index] = buf; })
            .catch(err => console.warn('[bird-sfx] load failed:', url, err.message));
    });
}

// Eagerly fetch + decode one species' clips so the first call doesn't wait on I/O.
export function preloadBirdSfx(species) {
    bindGlobalAudioUnlock();
    startLoadingBuffers(species);
}

// Play one clip of the species. `clipIndex` picks a voice (wrapped into the
// decoded set); gain/playbackRate/pan are the caller's variation. Drops the
// call silently if nothing has decoded yet — a bird that calls late is a
// different bird, not a queued replay.
export function playBirdCall(species, { clipIndex = 0, gain = 0.2, playbackRate = 1.0, pan = 0 } = {}) {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    if (!loadStartedSpecies.has(species)) startLoadingBuffers(species);
    const ready = (buffersBySpecies.get(species) || []).filter(Boolean);
    if (ready.length === 0) return false;
    const buf = ready[Math.abs(Math.floor(clipIndex)) % ready.length];

    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.5, Math.min(2.0, playbackRate));
    const g = c.createGain();
    g.gain.value = Math.max(0, Math.min(1, gain));
    let tail = g;
    // Older Safari has no StereoPannerNode; the call is simply centred there.
    if (typeof c.createStereoPanner === 'function') {
        const panner = c.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        tail = g.connect(panner);
    }
    src.connect(g);
    tail.connect(getAudioDestination(c));
    src.start();
    return true;
}
