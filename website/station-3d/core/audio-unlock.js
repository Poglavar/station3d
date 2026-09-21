// Shared browser-audio gate plus one app-level master output per AudioContext.
// Every Station3D sound graph connects through getAudioDestination(), allowing
// one persisted mute switch to silence the whole simulator and a temporary
// dialogue duck to lower world sound without suspending contexts (suspension
// would queue one-shot sounds and release them in a burst).

const MUTE_STORAGE_KEY = 'station3dAudioMuted';

let audioUnlocked = false;
let unlockListenersBound = false;
const unlockCallbacks = new Set();
const muteCallbacks = new Set();
const contextOutputs = new Map();
const mediaElements = new Set();
const DUCKED_GAIN = 0.28;

function readStoredMute() {
    try {
        return typeof localStorage !== 'undefined'
            && localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
    } catch (_) {
        return false;
    }
}

let audioMuted = readStoredMute();
let audioDucked = false;

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'];
const UNLOCK_LISTENER_OPTIONS = { capture: true, passive: true };

function flushUnlockCallbacks() {
    if (unlockCallbacks.size === 0) return;
    const callbacks = Array.from(unlockCallbacks);
    unlockCallbacks.clear();
    for (const cb of callbacks) {
        try { cb(); } catch (_) {}
    }
}

function onAudioUnlocked() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (typeof window !== 'undefined') {
        for (const eventName of UNLOCK_EVENTS) {
            window.removeEventListener(eventName, onAudioUnlocked, UNLOCK_LISTENER_OPTIONS);
        }
    }
    flushUnlockCallbacks();
}

export function bindGlobalAudioUnlock() {
    if (unlockListenersBound || typeof window === 'undefined') return;
    unlockListenersBound = true;
    for (const eventName of UNLOCK_EVENTS) {
        window.addEventListener(eventName, onAudioUnlocked, UNLOCK_LISTENER_OPTIONS);
    }
}

export function hasAudioUnlock() {
    bindGlobalAudioUnlock();
    return audioUnlocked;
}

export function whenAudioUnlocked(callback) {
    if (typeof callback !== 'function') return () => {};
    bindGlobalAudioUnlock();
    if (audioUnlocked) {
        callback();
        return () => {};
    }
    unlockCallbacks.add(callback);
    return () => unlockCallbacks.delete(callback);
}

function outputGain() {
    if (audioMuted) return 0;
    return audioDucked ? DUCKED_GAIN : 1;
}

function setOutputGain(ctx, output, { smooth = false } = {}) {
    if (!ctx || !output?.gain) return;
    const value = outputGain();
    try {
        output.gain.cancelScheduledValues(ctx.currentTime);
        if (smooth && typeof output.gain.setTargetAtTime === 'function') {
            output.gain.setTargetAtTime(value, ctx.currentTime, 0.08);
        } else {
            output.gain.setValueAtTime(value, ctx.currentTime);
        }
    } catch (_) {
        output.gain.value = value;
    }
}

export function registerAudioContext(ctx) {
    if (!ctx || contextOutputs.has(ctx)) return ctx || null;
    try {
        const output = ctx.createGain();
        output.gain.value = outputGain();
        output.connect(ctx.destination);
        contextOutputs.set(ctx, output);
        if (typeof ctx.addEventListener === 'function') {
            ctx.addEventListener('statechange', () => {
                if (ctx.state === 'closed') contextOutputs.delete(ctx);
            });
        }
    } catch (_) {
        // A browser without a usable GainNode still gets the context; callers
        // fall back to its native destination, so audio remains functional.
    }
    return ctx;
}

export function getAudioDestination(ctx) {
    return contextOutputs.get(ctx) || ctx?.destination || null;
}

export function registerAudioElement(element) {
    if (!element) return element;
    element.muted = audioMuted;
    if (!mediaElements.has(element)) {
        mediaElements.add(element);
        const forget = () => mediaElements.delete(element);
        element.addEventListener?.('ended', forget, { once: true });
        element.addEventListener?.('error', forget, { once: true });
    }
    return element;
}

export function isAudioMuted() {
    return audioMuted;
}

export function isAudioDucked() {
    return audioDucked;
}

// Dialogue speech is not routed through the world Web Audio graphs, so their
// shared output can dip without attenuating the actor's media/synthesis voice.
export function setAudioDucked(ducked) {
    const next = !!ducked;
    if (audioDucked === next) return audioDucked;
    audioDucked = next;
    for (const [ctx, output] of contextOutputs) {
        setOutputGain(ctx, output, { smooth: true });
    }
    return audioDucked;
}

export function setAudioMuted(muted) {
    const next = !!muted;
    if (audioMuted === next) return audioMuted;
    audioMuted = next;
    try { localStorage.setItem(MUTE_STORAGE_KEY, String(audioMuted)); } catch (_) {}
    for (const [ctx, output] of contextOutputs) setOutputGain(ctx, output);
    for (const element of mediaElements) element.muted = audioMuted;
    for (const callback of muteCallbacks) {
        try { callback(audioMuted); } catch (_) {}
    }
    return audioMuted;
}

export function toggleAudioMuted() {
    return setAudioMuted(!audioMuted);
}

export function onAudioMuteChange(callback) {
    if (typeof callback !== 'function') return () => {};
    muteCallbacks.add(callback);
    callback(audioMuted);
    return () => muteCallbacks.delete(callback);
}

export function createUnlockedAudioContext() {
    if (!hasAudioUnlock()) return null;
    const Ctor = (typeof window !== 'undefined')
        && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    try {
        return registerAudioContext(new Ctor());
    } catch (_) {
        return null;
    }
}

export function resumeUnlockedAudioContext(ctx) {
    if (!ctx) return false;
    if (!hasAudioUnlock()) return ctx.state !== 'suspended';
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
            const maybePromise = ctx.resume();
            if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch(() => {});
            }
        } catch (_) {}
    }
    return true;
}
