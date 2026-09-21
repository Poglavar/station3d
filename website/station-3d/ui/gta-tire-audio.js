// Lifecycle-safe recorded tire scrub/squeal with a procedural fallback. Real
// Rapier wheel impulses drive both paths; the graph stays silent while rolling.

import { getAudioDestination } from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const TIRE_SAMPLE_URL = station3dAssetUrl('audio/sfx/tire-skid/skid-loop.wav');
const tireSampleByContext = new WeakMap();

function disconnectQuietly(node) {
    try { node?.disconnect?.(); } catch (_) { /* already disconnected */ }
}

function stopQuietly(node, when) {
    try { node?.stop?.(when); } catch (_) { /* already stopped */ }
}

function makeNoiseBuffer(ctx) {
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    let filtered = 0;
    for (let index = 0; index < channel.length; index += 1) {
        filtered = filtered * 0.58 + (Math.random() * 2 - 1) * 0.42;
        channel[index] = filtered;
    }
    return buffer;
}

function loadTireSample(ctx) {
    const existing = tireSampleByContext.get(ctx);
    if (existing) return existing;
    const promise = fetch(TIRE_SAMPLE_URL, { cache: 'force-cache' })
        .then((response) => {
            if (!response.ok) {
                throw new Error(`tire sample HTTP ${response.status}: ${TIRE_SAMPLE_URL}`);
            }
            return response.arrayBuffer();
        })
        .then((bytes) => ctx.decodeAudioData(bytes))
        .catch((error) => {
            tireSampleByContext.delete(ctx);
            throw error;
        });
    tireSampleByContext.set(ctx, promise);
    return promise;
}

function attachRecordedTire(graph, buffer) {
    if (!graph || !buffer) return false;
    const { ctx } = graph;
    const sampleFilter = ctx.createBiquadFilter();
    sampleFilter.type = 'lowpass';
    sampleFilter.frequency.value = 5200;
    sampleFilter.Q.value = 0.35;
    const sampleGain = ctx.createGain();
    sampleGain.gain.value = 0.92;
    sampleFilter.connect(sampleGain);
    sampleGain.connect(graph.output);
    const sample = ctx.createBufferSource();
    sample.buffer = buffer;
    sample.loop = true;
    sample.connect(sampleFilter);
    sample.start();
    graph.sample = sample;
    graph.sampleFilter = sampleFilter;
    graph.sampleGain = sampleGain;
    graph.sampleState = 'ready';
    // Retain a quiet synthetic texture underneath the recording so a browser
    // decoder or loop-boundary quirk can never turn active tyre feedback off.
    graph.syntheticGain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.08);
    return true;
}

export function createGtaTireAudio({ ensureContext } = {}) {
    let graph = null;
    let running = false;

    function initialize() {
        if (!running || graph) return !!graph;
        const ctx = typeof ensureContext === 'function' ? ensureContext() : null;
        const destination = ctx && ctx.state !== 'closed' ? getAudioDestination(ctx) : null;
        if (!ctx || !destination) return false;
        const output = ctx.createGain();
        output.gain.value = 0;
        output.connect(destination);
        const syntheticGain = ctx.createGain();
        syntheticGain.gain.value = 1;
        syntheticGain.connect(output);
        const bandpass = ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = 980;
        bandpass.Q.value = 3.6;
        bandpass.connect(syntheticGain);
        const noise = ctx.createBufferSource();
        noise.buffer = makeNoiseBuffer(ctx);
        noise.loop = true;
        noise.connect(bandpass);
        const toneGain = ctx.createGain();
        toneGain.gain.value = 0.11;
        toneGain.connect(syntheticGain);
        const tone = ctx.createOscillator();
        tone.type = 'triangle';
        tone.frequency.value = 720;
        tone.connect(toneGain);
        noise.start();
        tone.start();
        graph = {
            ctx,
            output,
            syntheticGain,
            bandpass,
            noise,
            toneGain,
            tone,
            sample: null,
            sampleFilter: null,
            sampleGain: null,
            sampleState: 'loading',
        };
        const initializedGraph = graph;
        loadTireSample(ctx).then((buffer) => {
            if (!running || graph !== initializedGraph) return;
            attachRecordedTire(initializedGraph, buffer);
        }).catch((error) => {
            if (graph !== initializedGraph) return;
            initializedGraph.sampleState = 'failed';
            console.warn('[gta-tire-audio] recorded sample unavailable; using synthesis', error);
        });
        return true;
    }

    function stopGraph() {
        const current = graph;
        graph = null;
        if (!current) return;
        const now = current.ctx.currentTime;
        current.output.gain.cancelScheduledValues(now);
        current.output.gain.setTargetAtTime(0, now, 0.025);
        const stopAt = now + 0.16;
        for (const source of [current.noise, current.tone, current.sample]) {
            stopQuietly(source, stopAt);
        }
        setTimeout(() => {
            for (const node of [
                current.noise,
                current.tone,
                current.toneGain,
                current.bandpass,
                current.syntheticGain,
                current.sampleFilter,
                current.sampleGain,
                current.output,
            ]) disconnectQuietly(node);
        }, 220);
    }

    return {
        start() {
            if (running) return;
            running = true;
            initialize();
        },
        update({ squeal = 0, pitch = 0 } = {}) {
            if (!running) running = true;
            if (!initialize() || !graph) return;
            const intensity = Math.max(0, Math.min(1, Number(squeal) || 0));
            const pitchAmount = Math.max(0, Math.min(1, Number(pitch) || 0));
            const now = graph.ctx.currentTime;
            graph.output.gain.setTargetAtTime(
                intensity * (graph.sampleState === 'ready' ? 0.14 : 0.09),
                now,
                0.045,
            );
            graph.bandpass.frequency.setTargetAtTime(760 + pitchAmount * 920, now, 0.06);
            graph.bandpass.Q.setTargetAtTime(2.6 + intensity * 3.2, now, 0.07);
            graph.tone.frequency.setTargetAtTime(610 + pitchAmount * 620, now, 0.055);
            graph.sample?.playbackRate?.setTargetAtTime(
                0.82 + pitchAmount * 0.42,
                now,
                0.06,
            );
        },
        stop() {
            running = false;
            stopGraph();
        },
        dispose() {
            running = false;
            stopGraph();
        },
        debugState() {
            return {
                running,
                initialized: !!graph,
                sampleState: graph?.sampleState || 'inactive',
            };
        },
    };
}
