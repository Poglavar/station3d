// Recorded car-horn samples (Mixkit, royalty-free). Decoded once into Web
// Audio buffers; each playback picks one at random and goes through gain +
// playbackRate so the caller can apply distance attenuation and per-car
// pitch jitter.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const HONK_FILES = [
    station3dAssetUrl('audio/sfx/honk/1.mp3'),
    station3dAssetUrl('audio/sfx/honk/2.mp3'),
    station3dAssetUrl('audio/sfx/honk/3.mp3'),
    station3dAssetUrl('audio/sfx/honk/4.mp3'),
    station3dAssetUrl('audio/sfx/honk/5.mp3'),
];

let ctx = null;
const buffers = [];      // decoded AudioBuffers, may be sparse during load
let loadStarted = false;
let unlockCancel = null;

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

function queueBufferLoadOnUnlock() {
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
        queueBufferLoadOnUnlock();
        return;
    }
    loadStarted = true;
    HONK_FILES.forEach((url, idx) => {
        fetch(url)
            .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`honk fetch ${r.status}`)))
            .then(ab => c.decodeAudioData(ab))
            .then(buf => { buffers[idx] = buf; })
            .catch(err => console.warn('[honk-sfx] load failed:', url, err.message));
    });
}

// Eagerly start fetching + decoding so the first hit doesn't wait on I/O.
export function preloadHonkSfx() {
    bindGlobalAudioUnlock();
    startLoadingBuffers();
}

// Play a random horn sample with per-call gain (0..1, expected to encode
// distance attenuation) and playbackRate (≈1.0; small deviations sound like
// a different car horn). Drops the call silently if no buffer has decoded
// yet — better than queuing a delayed honk after the moment has passed.
export function playHonk({ gain = 1.0, playbackRate = 1.0 } = {}) {
    const c = ensureCtx();
    if (!c) return;
    resumeUnlockedAudioContext(c);
    if (!loadStarted) startLoadingBuffers();
    const ready = buffers.filter(Boolean);
    if (ready.length === 0) return;
    const buf = ready[Math.floor(Math.random() * ready.length)];

    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.5, Math.min(2.0, playbackRate));
    const g = c.createGain();
    g.gain.value = Math.max(0, Math.min(1, gain));
    src.connect(g).connect(getAudioDestination(c));
    src.start();
}
