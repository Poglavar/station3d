// The sound of the smuggler's engine giving up: two coughs of misfires with
// exhaust puffs, then one last wheeze. Fully procedural, scheduled up front
// and self-cleaning, so it costs the renderer nothing after the call.

import {
    createUnlockedAudioContext,
    getAudioDestination,
    isAudioMuted,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';

export const SPUTTER_DURATION_S = 2.4;
const MAX_GAIN = 0.34;
const NOISE_SECONDS = 0.6;
// Misfire pops (seconds after the cue starts): "trut trut trut … trut trut … puff".
export const SPUTTER_POP_TIMES_S = Object.freeze([0, 0.12, 0.25, 0.98, 1.12, 1.68]);
// Exhaust puffs: [start, length, centre frequency, filter type]
export const SPUTTER_PUFFS = Object.freeze([
    Object.freeze({ atS: 0.02, lengthS: 0.14, frequencyHz: 700, type: 'bandpass' }),
    Object.freeze({ atS: 1.0, lengthS: 0.22, frequencyHz: 480, type: 'bandpass' }),
    Object.freeze({ atS: 1.66, lengthS: 0.55, frequencyHz: 420, type: 'lowpass', sweepToHz: 160 }),
]);
let context = null;

function disconnectQuietly(node) {
    try { node?.disconnect?.(); } catch (_) { /* already disconnected */ }
}

function stopQuietly(node, when) {
    try { node?.stop?.(when); } catch (_) { /* already stopped */ }
}

function noiseBuffer(ctx) {
    const sampleRate = ctx.sampleRate || 44100;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(sampleRate * NOISE_SECONDS)), sampleRate);
    const data = buffer.getChannelData?.(0);
    // Deterministic, cheap pseudo-noise; one allocation per cue.
    if (data) for (let i = 0, seed = 0x2545f491; i < data.length; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    return buffer;
}

// Exported separately so a fake AudioContext can assert the whole graph.
export function scheduleAircraftEngineSputterSfx(ctx, destination, { gain = MAX_GAIN } = {}) {
    if (!ctx || !destination || typeof ctx.createGain !== 'function'
        || typeof ctx.createOscillator !== 'function' || typeof ctx.createBufferSource !== 'function'
        || typeof ctx.createBuffer !== 'function' || typeof ctx.createBiquadFilter !== 'function') return null;
    const now = Number(ctx.currentTime) || 0;
    const output = ctx.createGain();
    output.gain.value = Math.max(0, Math.min(MAX_GAIN, Number(gain) || 0));
    output.connect(destination);
    const nodes = [output];
    const sources = [];

    for (const atS of SPUTTER_POP_TIMES_S) {
        const start = now + atS;
        const pop = ctx.createOscillator();
        pop.type = 'triangle';
        pop.frequency.setValueAtTime?.(74, start);
        pop.frequency.exponentialRampToValueAtTime?.(36, start + 0.07);
        const popGain = ctx.createGain();
        popGain.gain.setValueAtTime?.(0.0001, start);
        popGain.gain.exponentialRampToValueAtTime?.(1, start + 0.008);
        popGain.gain.exponentialRampToValueAtTime?.(0.0001, start + 0.11);
        pop.connect(popGain);
        popGain.connect(output);
        pop.start(start);
        pop.stop(start + 0.13);
        nodes.push(pop, popGain);
        sources.push(pop);
    }

    const buffer = noiseBuffer(ctx);
    for (const puff of SPUTTER_PUFFS) {
        const start = now + puff.atS;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = puff.type;
        filter.frequency.setValueAtTime?.(puff.frequencyHz, start);
        if (puff.sweepToHz) filter.frequency.exponentialRampToValueAtTime?.(puff.sweepToHz, start + puff.lengthS);
        filter.Q.value = puff.type === 'bandpass' ? 0.8 : 0.6;
        const puffGain = ctx.createGain();
        puffGain.gain.setValueAtTime?.(0.0001, start);
        puffGain.gain.exponentialRampToValueAtTime?.(0.7, start + 0.012);
        puffGain.gain.exponentialRampToValueAtTime?.(0.0001, start + puff.lengthS);
        noise.connect(filter);
        filter.connect(puffGain);
        puffGain.connect(output);
        noise.start(start);
        noise.stop(start + puff.lengthS + 0.02);
        nodes.push(noise, filter, puffGain);
        sources.push(noise);
    }

    let stopped = false;
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        for (const node of nodes) disconnectQuietly(node);
    };
    // The last puff ends the cue; its onended releases the whole graph.
    sources.at(-1).onended = cleanup;
    return {
        stop() {
            if (stopped) return;
            for (const source of sources) stopQuietly(source, now);
            cleanup();
        },
        durationS: SPUTTER_DURATION_S,
    };
}

export function playAircraftEngineSputterSfx({
    createContext = createUnlockedAudioContext,
    destinationFor = getAudioDestination,
    muted = isAudioMuted,
} = {}) {
    if (muted()) return null;
    if (!context || context.state === 'closed') context = createContext();
    if (!context || context.state === 'closed') return null;
    resumeUnlockedAudioContext(context);
    // A one-shot, never deferred audio: a still-suspended context stays quiet.
    if (context.state === 'suspended') return null;
    return scheduleAircraftEngineSputterSfx(context, destinationFor(context));
}
