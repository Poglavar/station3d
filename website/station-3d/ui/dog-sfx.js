import { station3dAssetUrl } from '../core/asset-url.js';
// Recorded CC0 dog calls (sources documented alongside the assets), decoded
// once after the shared user-gesture audio unlock. Playback is positional and
// globally sparse; the pedestrian layer decides which visible dog called.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

const DOG_FILES = [
    station3dAssetUrl('audio/sfx/dogs/dog-bark-1.wav'),
    station3dAssetUrl('audio/sfx/dogs/dog-bark-2.wav'),
    station3dAssetUrl('audio/sfx/dogs/dog-bark-3.wav'),
];
const DOG_PANT_FILE = station3dAssetUrl('audio/world/dog-pant.wav');

let ctx = null;
let buffers = [];
let loadStarted = false;
let loadWanted = false;
let pantBuffer = null;
let unlockCancel = null;
const activeSources = new Set();

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

function startLoadingBuffers() {
    if (loadStarted) return;
    const c = ensureCtx();
    if (!c) {
        loadWanted = true;
        bindGlobalAudioUnlock();
        if (!unlockCancel) {
            unlockCancel = whenAudioUnlocked(() => {
                unlockCancel = null;
                if (loadWanted) startLoadingBuffers();
            });
        }
        return;
    }
    loadStarted = true;
    buffers = [];
    DOG_FILES.forEach((url, index) => {
        fetch(url)
            .then(response => (response.ok
                ? response.arrayBuffer()
                : Promise.reject(new Error(`dog fetch ${response.status}`))))
            .then(bytes => c.decodeAudioData(bytes))
            .then(buffer => { buffers[index] = buffer; })
            .catch(error => console.warn('[dog-sfx] load failed:', url, error.message));
    });
    fetch(DOG_PANT_FILE).then(response => {
        if (!response.ok) throw new Error(`dog pant fetch ${response.status}`);
        return response.arrayBuffer();
    }).then(bytes => c.decodeAudioData(bytes)).then(buffer => { pantBuffer = buffer; })
        .catch(error => console.warn('[dog-sfx] pant load failed:', error.message));
}

export function dogClipCount() {
    return DOG_FILES.length;
}

export function preloadDogSfx() {
    bindGlobalAudioUnlock();
    startLoadingBuffers();
}

export function playDogPant({ gain = 0.45 } = {}) {
    const c = ensureCtx(); if (!c || !pantBuffer) return false;
    const source = c.createBufferSource(); source.buffer = pantBuffer;
    const g = c.createGain(); g.gain.value = Math.max(0, Math.min(1, gain));
    source.connect(g); g.connect(getAudioDestination(c)); source.onended = () => activeSources.delete(source);
    activeSources.add(source); resumeUnlockedAudioContext(c); source.start(); return true;
}

export function playDogBark({ clipIndex = 0, gain = 0.3, playbackRate = 1, pan = 0 } = {}) {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    if (!loadStarted) startLoadingBuffers();
    const ready = buffers.filter(Boolean);
    if (ready.length === 0) return false;
    const buffer = ready[Math.abs(Math.floor(clipIndex)) % ready.length];
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.75, Math.min(1.35, playbackRate));
    const gainNode = c.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, gain));
    let tail = gainNode;
    if (typeof c.createStereoPanner === 'function') {
        const panner = c.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        tail = gainNode.connect(panner);
    }
    source.connect(gainNode);
    tail.connect(getAudioDestination(c));
    source.onended = () => activeSources.delete(source);
    activeSources.add(source);
    source.start();
    return true;
}

export function stopDogSfx() {
    for (const source of activeSources) {
        try { source.stop(); } catch (_error) { /* already stopped */ }
    }
    activeSources.clear();
}
