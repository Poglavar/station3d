// Owns the GTA player car's managed Web Audio graph, recorded engine loops,
// procedural fallback, and lifecycle-safe start/update/stop behavior.

import {
    gtaEngineAudioTargets,
    gtaEngineSampleMix,
} from '../core/gta-engine-audio-model.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import { getAudioDestination } from '../core/audio-unlock.js';

const GAIN_SMOOTH_S = 0.08;
const PITCH_SMOOTH_S = 0.055;
const ENGINE_SAMPLE_URLS = Object.freeze(Array.from(
    { length: 6 },
    (_value, index) => station3dAssetUrl(`audio/sfx/car-engine/loop-${index}.wav`),
));
const engineSampleBankByContext = new WeakMap();

function disconnectQuietly(node) {
    try { node?.disconnect?.(); } catch (_) { /* already disconnected */ }
}

function stopQuietly(node, when) {
    try { node?.stop?.(when); } catch (_) { /* already stopped */ }
}

function loadEngineSampleBank(ctx) {
    const existing = engineSampleBankByContext.get(ctx);
    if (existing) return existing;
    const promise = Promise.all(ENGINE_SAMPLE_URLS.map(async (url) => {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`engine sample HTTP ${response.status}: ${url}`);
        return ctx.decodeAudioData(await response.arrayBuffer());
    })).catch((error) => {
        engineSampleBankByContext.delete(ctx);
        throw error;
    });
    engineSampleBankByContext.set(ctx, promise);
    return promise;
}

function makeNoiseBuffer(ctx) {
    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < sampleCount; index += 1) {
        const white = Math.random() * 2 - 1;
        previous = previous * 0.82 + white * 0.18;
        channel[index] = previous;
    }
    return buffer;
}

function playStarter(ctx, engineOutput) {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    gain.connect(engineOutput);

    const starter = ctx.createOscillator();
    starter.type = 'sawtooth';
    starter.frequency.setValueAtTime(42, now);
    starter.frequency.exponentialRampToValueAtTime(78, now + 0.34);
    starter.connect(gain);
    starter.onended = () => {
        disconnectQuietly(starter);
        disconnectQuietly(gain);
    };
    starter.start(now);
    starter.stop(now + 0.45);
}

function applyRecordedEngineTargets(graph, targets) {
    if (!Array.isArray(graph.sampleVoices) || graph.sampleVoices.length === 0) return;
    const mix = gtaEngineSampleMix(targets.rpm, graph.sampleVoices.length);
    const now = graph.ctx.currentTime;
    graph.sampleFilter.frequency.setTargetAtTime(
        Math.min(6200, Math.max(900, targets.filterHz * 1.5)),
        now,
        0.08,
    );
    for (let index = 0; index < graph.sampleVoices.length; index += 1) {
        const voice = graph.sampleVoices[index];
        voice.source.playbackRate.setTargetAtTime(
            mix.playbackRate,
            now,
            PITCH_SMOOTH_S,
        );
        voice.gain.gain.setTargetAtTime(
            mix.gains[index] * 0.92,
            now,
            GAIN_SMOOTH_S,
        );
    }
}

function attachRecordedEngine(graph, buffers) {
    if (!graph || !Array.isArray(buffers) || buffers.length === 0) return false;
    const { ctx } = graph;
    const now = ctx.currentTime;
    const sampleFilter = ctx.createBiquadFilter();
    sampleFilter.type = 'lowpass';
    sampleFilter.frequency.value = 1800;
    sampleFilter.Q.value = 0.45;
    sampleFilter.connect(graph.engineOutput);
    const sampleVoices = buffers.map((buffer) => {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(sampleFilter);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start(now);
        return { source, gain };
    });
    graph.sampleFilter = sampleFilter;
    graph.sampleVoices = sampleVoices;
    graph.sampleState = 'ready';
    // Keep only a quiet synthesized foundation once the real recording bank
    // is present. It remains the complete fallback when loading fails.
    graph.pulseGain.gain.setTargetAtTime(0.035, now, 0.12);
    graph.bodyGain.gain.setTargetAtTime(0.025, now, 0.12);
    graph.harmonicGain.gain.setTargetAtTime(0.008, now, 0.12);
    applyRecordedEngineTargets(
        graph,
        graph.lastTargets || gtaEngineAudioTargets(),
    );
    return true;
}

export function createGtaEngineAudio({ ensureContext } = {}) {
    let graph = null;
    let running = false;

    function context() {
        const ctx = typeof ensureContext === 'function' ? ensureContext() : null;
        return ctx && ctx.state !== 'closed' ? ctx : null;
    }

    function initialize() {
        if (!running || graph) return !!graph;
        const ctx = context();
        if (!ctx) return false;
        const engineOutput = ctx.createGain();
        engineOutput.gain.value = 0;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 18;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.16;
        engineOutput.connect(compressor);
        compressor.connect(getAudioDestination(ctx));

        const toneFilter = ctx.createBiquadFilter();
        toneFilter.type = 'lowpass';
        toneFilter.frequency.value = 900;
        toneFilter.Q.value = 0.8;
        toneFilter.connect(engineOutput);

        const pulseGain = ctx.createGain();
        pulseGain.gain.value = 0.62;
        pulseGain.connect(toneFilter);
        const pulse = ctx.createOscillator();
        pulse.type = 'sawtooth';
        pulse.frequency.value = 28;
        pulse.connect(pulseGain);

        const bodyGain = ctx.createGain();
        bodyGain.gain.value = 0.42;
        bodyGain.connect(toneFilter);
        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.value = 14;
        body.connect(bodyGain);

        const harmonicGain = ctx.createGain();
        harmonicGain.gain.value = 0.16;
        harmonicGain.connect(toneFilter);
        const harmonic = ctx.createOscillator();
        harmonic.type = 'square';
        harmonic.frequency.value = 56;
        harmonic.detune.value = 4;
        harmonic.connect(harmonicGain);

        const intakeFilter = ctx.createBiquadFilter();
        intakeFilter.type = 'bandpass';
        intakeFilter.frequency.value = 760;
        intakeFilter.Q.value = 0.65;
        const intakeGain = ctx.createGain();
        intakeGain.gain.value = 0;
        intakeFilter.connect(intakeGain);
        intakeGain.connect(engineOutput);
        const intake = ctx.createBufferSource();
        intake.buffer = makeNoiseBuffer(ctx);
        intake.loop = true;
        intake.connect(intakeFilter);

        for (const source of [pulse, body, harmonic, intake]) source.start();
        graph = {
            ctx,
            engineOutput,
            compressor,
            toneFilter,
            pulseGain,
            pulse,
            bodyGain,
            body,
            harmonicGain,
            harmonic,
            intakeFilter,
            intakeGain,
            intake,
            sampleFilter: null,
            sampleVoices: [],
            sampleState: 'loading',
            lastTargets: null,
        };
        const initializedGraph = graph;
        loadEngineSampleBank(ctx).then((buffers) => {
            if (!running || graph !== initializedGraph) return;
            attachRecordedEngine(initializedGraph, buffers);
        }).catch((error) => {
            if (graph !== initializedGraph) return;
            initializedGraph.sampleState = 'failed';
            console.warn('[gta-engine-audio] recorded sample bank unavailable; using synthesis', error);
        });
        playStarter(ctx, engineOutput);
        return true;
    }

    function stopGraph() {
        const current = graph;
        graph = null;
        if (!current) return;
        const now = current.ctx.currentTime;
        current.engineOutput.gain.cancelScheduledValues(now);
        current.engineOutput.gain.setTargetAtTime(0, now, 0.055);
        const stopAt = now + 0.28;
        const sampleSources = current.sampleVoices.map(voice => voice.source);
        for (const source of [
            current.pulse,
            current.body,
            current.harmonic,
            current.intake,
            ...sampleSources,
        ]) {
            source.onended = () => disconnectQuietly(source);
            stopQuietly(source, stopAt);
        }
        setTimeout(() => {
            for (const node of [
                current.pulseGain,
                current.bodyGain,
                current.harmonicGain,
                current.intakeFilter,
                current.intakeGain,
                current.toneFilter,
                current.sampleFilter,
                ...current.sampleVoices.map(voice => voice.gain),
                current.engineOutput,
                current.compressor,
            ]) disconnectQuietly(node);
        }, 360);
    }

    return {
        start() {
            if (running) return;
            running = true;
            initialize();
        },
        update(state) {
            if (!running && !state) return;
            if (!running) running = true;
            if (!initialize() || !graph) return;
            const targets = gtaEngineAudioTargets(state);
            graph.lastTargets = targets;
            const now = graph.ctx.currentTime;
            graph.engineOutput.gain.setTargetAtTime(
                targets.masterGain,
                now,
                GAIN_SMOOTH_S,
            );
            graph.pulse.frequency.setTargetAtTime(targets.firingHz, now, PITCH_SMOOTH_S);
            graph.body.frequency.setTargetAtTime(targets.firingHz * 0.5, now, PITCH_SMOOTH_S);
            graph.harmonic.frequency.setTargetAtTime(targets.firingHz * 2.03, now, PITCH_SMOOTH_S);
            graph.pulse.detune.setTargetAtTime(targets.detuneCents, now, 0.16);
            graph.body.detune.setTargetAtTime(targets.detuneCents * 0.6, now, 0.16);
            graph.toneFilter.frequency.setTargetAtTime(targets.filterHz, now, 0.08);
            graph.intakeFilter.frequency.setTargetAtTime(
                Math.min(2600, 560 + targets.rpm * 0.31),
                now,
                0.09,
            );
            graph.intakeGain.gain.setTargetAtTime(
                targets.intakeGain,
                now,
                GAIN_SMOOTH_S,
            );
            applyRecordedEngineTargets(graph, targets);
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
                sampleVoices: graph?.sampleVoices.length || 0,
            };
        },
    };
}
