// Pre-generated, alternating two-voice pedestrian conversations. No runtime
// API calls: MP3s are decoded after the normal Station3D audio unlock.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import {
    CONVERSATION_LANGUAGES,
    pedestrianConversationLine,
    PEDESTRIAN_CONVERSATIONS,
    setPedestrianConversationClips,
    STREET_VOICE_MANIFEST_URL,
} from '../core/pedestrian-conversations.js';

const conversationFiles = () => [...new Set(PEDESTRIAN_CONVERSATIONS.flatMap(script => script.lines.flatMap(line => (
    CONVERSATION_LANGUAGES.map(language => pedestrianConversationLine(line, language).file)
))))];
let ctx = null;
let buffers = new Map();
let loadStarted = false;
let loadWanted = false;
let unlockCancel = null;
let activeLine = null;

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

function startLoading() {
    if (loadStarted) return;
    const c = ensureCtx();
    if (!c) {
        loadWanted = true;
        bindGlobalAudioUnlock();
        if (!unlockCancel) {
            unlockCancel = whenAudioUnlocked(() => {
                unlockCancel = null;
                if (loadWanted) startLoading();
            });
        }
        return;
    }
    loadStarted = true;
    buffers = new Map();
    // Recorded takes replace generated clips line by line, so the voice
    // manifest decides which files there are to fetch.
    fetch(STREET_VOICE_MANIFEST_URL, { cache: 'no-cache' })
        .then(response => (response.ok
            ? response.json()
            : Promise.reject(new Error(`voice manifest fetch ${response.status}`))))
        .catch(error => {
            console.warn('[pedestrian-conversation] voice manifest failed, playing generated clips:', error.message);
            return null;
        })
        .then(manifest => {
            setPedestrianConversationClips(manifest);
            for (const file of conversationFiles()) {
                fetch(file)
                    .then(response => (response.ok
                        ? response.arrayBuffer()
                        : Promise.reject(new Error(`conversation fetch ${response.status}`))))
                    .then(bytes => c.decodeAudioData(bytes))
                    .then(buffer => buffers.set(file, buffer))
                    .catch(error => console.warn('[pedestrian-conversation] load failed:', file, error.message));
            }
        });
}

export function preloadPedestrianConversations() {
    bindGlobalAudioUnlock();
    startLoading();
}

export function playPedestrianConversationLine(line, { gain = 0.35, pan = 0 } = {}, onEnded = () => {}) {
    const c = ensureCtx();
    if (!c || activeLine || !line?.file) return false;
    resumeUnlockedAudioContext(c);
    if (!loadStarted) startLoading();
    const buffer = buffers.get(line.file);
    if (!buffer) return false;

    const source = c.createBufferSource();
    source.buffer = buffer;
    const gainNode = c.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, gain));
    let tail = gainNode;
    let panner = null;
    if (typeof c.createStereoPanner === 'function') {
        panner = c.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        tail = gainNode.connect(panner);
    }
    source.connect(gainNode);
    tail.connect(getAudioDestination(c));
    const voice = { source, gainNode, panner, gain: gainNode.gain.value, pan: panner?.pan.value ?? 0 };
    source.onended = () => {
        source.disconnect();
        gainNode.disconnect();
        panner?.disconnect();
        if (activeLine !== voice) return;
        activeLine = null;
        onEnded();
    };
    activeLine = voice;
    source.start();
    return true;
}

function smoothParameter(param, value, timeConstant = 0.055) {
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}

// Called throughout playback, including while waiting for the clip to end.
// Smooth both parameters to avoid clicks or abrupt left/right jumps on motion.
export function updatePedestrianConversationSpatial({ gain = 0, pan = 0 } = {}) {
    if (!activeLine) return false;
    const nextGain = Math.max(0, Math.min(1, gain));
    const nextPan = Math.max(-1, Math.min(1, pan));
    if (Math.abs(nextGain - activeLine.gain) > 0.0001) {
        smoothParameter(activeLine.gainNode.gain, nextGain);
        activeLine.gain = nextGain;
    }
    if (activeLine.panner && Math.abs(nextPan - activeLine.pan) > 0.0001) {
        smoothParameter(activeLine.panner.pan, nextPan);
        activeLine.pan = nextPan;
    }
    return true;
}

export function stopPedestrianConversations() {
    const voice = activeLine;
    activeLine = null;
    if (!voice) return;
    smoothParameter(voice.gainNode.gain, 0, 0.035);
    try { voice.source.stop(ctx.currentTime + 0.18); } catch (_error) { /* already stopped */ }
}
