// One short procedural impact cue for aircraft wreck transitions. It is
// deliberately immediate: a crash before browser audio unlock is quiet rather
// than being queued to surprise the player after a later click.

import {
    createUnlockedAudioContext,
    getAudioDestination,
    isAudioMuted,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';

const CRASH_DURATION_S = 1.15;
const MAX_GAIN = 0.28;
let context = null;

function disconnectQuietly(node) {
    try { node?.disconnect?.(); } catch (_) { /* already disconnected */ }
}

function stopQuietly(node, when) {
    try { node?.stop?.(when); } catch (_) { /* already stopped */ }
}

function ramp(gain, now, from, to, duration) {
    gain.gain.setValueAtTime?.(from, now);
    gain.gain.exponentialRampToValueAtTime?.(Math.max(0.0001, to), now + duration);
}

// Exported separately so a fake AudioContext can assert the full managed graph.
export function scheduleAircraftCrashSfx(ctx, destination, { gain = MAX_GAIN } = {}) {
    if (!ctx || !destination || typeof ctx.createGain !== 'function'
        || typeof ctx.createOscillator !== 'function' || typeof ctx.createBufferSource !== 'function'
        || typeof ctx.createBuffer !== 'function') return null;
    const now = Number(ctx.currentTime) || 0;
    const level = Math.max(0, Math.min(MAX_GAIN, Number(gain) || 0));
    const output = ctx.createGain();
    output.gain.value = level;
    output.connect(destination);

    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime?.(82, now);
    thump.frequency.exponentialRampToValueAtTime?.(34, now + 0.42);
    const thumpGain = ctx.createGain();
    ramp(thumpGain, now, 0.9, 0.0001, 0.48);
    thump.connect(thumpGain);
    thumpGain.connect(output);

    const noiseBuffer = ctx.createBuffer(1, Math.max(1, Math.floor((ctx.sampleRate || 44100) * CRASH_DURATION_S)), ctx.sampleRate || 44100);
    const data = noiseBuffer.getChannelData?.(0);
    // Deterministic, cheap pseudo-noise; allocation occurs once per cue, never per frame.
    if (data) for (let i = 0, seed = 0x9e3779b9; i < data.length; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = ((seed / 0xffffffff) * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    ramp(noiseGain, now, 0.72, 0.0001, CRASH_DURATION_S);
    noise.connect(noiseGain);
    noiseGain.connect(output);

    const stopAt = now + CRASH_DURATION_S;
    thump.start(now);
    noise.start(now);
    thump.stop(stopAt);
    noise.stop(stopAt);
    let stopped = false;
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        disconnectQuietly(thump);
        disconnectQuietly(thumpGain);
        disconnectQuietly(noise);
        disconnectQuietly(noiseGain);
        disconnectQuietly(output);
    };
    noise.onended = cleanup;
    return {
        stop() {
            if (stopped) return;
            stopQuietly(thump, now);
            stopQuietly(noise, now);
            cleanup();
        },
        durationS: CRASH_DURATION_S,
    };
}

export function playAircraftCrashSfx({
    createContext = createUnlockedAudioContext,
    destinationFor = getAudioDestination,
    muted = isAudioMuted,
} = {}) {
    if (muted()) return null;
    if (!context || context.state === 'closed') context = createContext();
    if (!context || context.state === 'closed') return null;
    resumeUnlockedAudioContext(context);
    // Never schedule while a context remains suspended: this is a one-shot,
    // not deferred audio for a future unlock.
    if (context.state === 'suspended') return null;
    return scheduleAircraftCrashSfx(context, destinationFor(context));
}

export { CRASH_DURATION_S };
