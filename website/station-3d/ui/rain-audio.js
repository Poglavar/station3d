// Two loopable CC0 field recordings replace the former generated noise bed.
// A quieter, drop-rich window recording carries drizzle; a steadier recording
// fades in as rainfall strengthens. Both use Station3D's shared mute/duck output.

import { station3dAssetUrl } from '../core/asset-url.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

const RAIN_FILES = Object.freeze([
    station3dAssetUrl('audio/sfx/rain/rain-light.mp3'),
    station3dAssetUrl('audio/sfx/rain/rain-steady.mp3'),
]);
const LIGHT_GAIN = 0.42;
const STEADY_GAIN = 0.22;
const GAIN_EPSILON = 0.002;

let context = null;
let sources = [];
let lightGain = null;
let steadyGain = null;
let rainFilter = null;
let loadPromise = null;
let loadError = null;
let lastLevel = 0;
let lastMuffle = 0;
let appliedLevel = -1;
let appliedMuffle = -1;
let unlockCancel = null;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothstep01(value) {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
}

function applyMix() {
    if (!context || sources.length !== RAIN_FILES.length) return;
    resumeUnlockedAudioContext(context);
    const now = context.currentTime;
    if (Math.abs(appliedLevel - lastLevel) > GAIN_EPSILON) {
        appliedLevel = lastLevel;
        const steadyMix = smoothstep01((lastLevel - 0.32) / 0.68);
        lightGain.gain.setTargetAtTime(
            lastLevel * LIGHT_GAIN * (1 - steadyMix * 0.46),
            now,
            0.18,
        );
        steadyGain.gain.setTargetAtTime(
            lastLevel * STEADY_GAIN * steadyMix,
            now,
            0.22,
        );
    }
    if (Math.abs(appliedMuffle - lastMuffle) > 0.01) {
        appliedMuffle = lastMuffle;
        rainFilter.frequency.setTargetAtTime(6800 - lastMuffle * 5300, now, 0.14);
    }
}

function buildGraph(buffers) {
    if (!context || sources.length) return;
    lightGain = context.createGain();
    steadyGain = context.createGain();
    lightGain.gain.value = 0;
    steadyGain.gain.value = 0;
    rainFilter = context.createBiquadFilter();
    rainFilter.type = 'lowpass';
    rainFilter.frequency.value = 6800;
    rainFilter.Q.value = 0.2;
    lightGain.connect(rainFilter);
    steadyGain.connect(rainFilter);
    rainFilter.connect(getAudioDestination(context));

    sources = buffers.map((buffer, index) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(index === 0 ? lightGain : steadyGain);
        source.start(0, Math.random() * Math.max(0, buffer.duration - 0.1));
        return source;
    });
    appliedLevel = -1;
    appliedMuffle = -1;
    applyMix();
}

function ensureGraph() {
    if (sources.length) return true;
    context = context || createUnlockedAudioContext();
    if (!context) return false;
    resumeUnlockedAudioContext(context);
    if (!loadPromise) {
        loadPromise = Promise.all(RAIN_FILES.map(url => fetch(url).then(response => {
            if (!response.ok) throw new Error(`rain recording fetch failed (${response.status})`);
            return response.arrayBuffer();
        }).then(bytes => context.decodeAudioData(bytes))))
            .then((buffers) => {
                loadError = null;
                buildGraph(buffers);
            })
            .catch((error) => {
                loadError = String(error?.message || error);
                console.warn('[rain-audio] CC0 recording load failed:', loadError);
            });
    }
    return false;
}

function queueGraph() {
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        if (lastLevel > GAIN_EPSILON) ensureGraph();
    });
}

export function updateRainAudio(level, muffled = 0) {
    lastLevel = clamp01(level);
    lastMuffle = clamp01(muffled);
    if (!sources.length && lastLevel > GAIN_EPSILON) {
        if (!ensureGraph()) queueGraph();
    }
    applyMix();
}

export function silenceRainAudio() {
    lastLevel = 0;
    applyMix();
}

export function getRainAudioSnapshot() {
    return Object.freeze({
        active: sources.length > 0 && lastLevel > GAIN_EPSILON,
        contextState: context?.state || null,
        level: lastLevel,
        muffled: lastMuffle,
        generated: false,
        recordings: RAIN_FILES.length,
        loading: !!loadPromise && sources.length === 0 && !loadError,
        error: loadError,
    });
}
