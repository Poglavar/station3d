// The splash of a jumping fish (CC0 — see audio/sfx/fish/SOURCES.md): one
// recording decoded once, each playback given its own gain, pitch, stereo pan
// and speed-of-sound delay by the caller (core/fish-jumps.js fishSplashCue).

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const SPLASH_URL = station3dAssetUrl('audio/sfx/fish/fish-splash.mp3');

let ctx = null;
let buffer = null;
let loading = false;
let unlockCancel = null;

function ensureCtx() {
    if (!ctx) ctx = createUnlockedAudioContext();
    return ctx;
}

function startLoading() {
    if (loading || buffer) return;
    const c = ensureCtx();
    if (!c) {
        bindGlobalAudioUnlock();
        if (!unlockCancel) {
            unlockCancel = whenAudioUnlocked(() => {
                unlockCancel = null;
                startLoading();
            });
        }
        return;
    }
    loading = true;
    fetch(SPLASH_URL)
        .then(response => (response.ok
            ? response.arrayBuffer()
            : Promise.reject(new Error(`fish splash HTTP ${response.status}`))))
        .then(bytes => c.decodeAudioData(bytes))
        .then((decoded) => { buffer = decoded; })
        .catch((error) => {
            loading = false;
            console.warn(`[fish-splash-sfx] ${new Date().toISOString()} load failed:`, error.message);
        });
}

// Fetch and decode ahead of the first jump.
export function preloadFishSplashSfx() {
    bindGlobalAudioUnlock();
    startLoading();
}

// Drops the splash silently while nothing has decoded: a missed splash is not
// replayed later.
export function playFishSplash({ gain = 0.3, playbackRate = 1, pan = 0, delayS = 0 } = {}) {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    if (!buffer) {
        startLoading();
        return false;
    }
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.5, Math.min(2, playbackRate));
    const level = c.createGain();
    level.gain.value = Math.max(0, Math.min(1, gain));
    let tail = level;
    // Older Safari has no StereoPannerNode; the splash is simply centred there.
    if (typeof c.createStereoPanner === 'function') {
        const panner = c.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        tail = level.connect(panner);
    }
    source.connect(level);
    tail.connect(getAudioDestination(c));
    source.start(c.currentTime + Math.max(0, delayS));
    return true;
}
