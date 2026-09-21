// Lifecycle-safe recorded engine and wake audio for player-controlled GTA
// boats and aircraft. The world pose drives gain and playback rate directly.

import { getAudioDestination } from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import { scheduleAircraftEngineSputterSfx } from './aircraft-engine-sputter-sfx.js';
import { NEUTRAL_ENGINE_MIX } from '../core/film-engine-audio.js';
import { specialVehicleAudioMix } from '../core/special-vehicle-audio-mix.js';

// The loop's rate over the failure: it stutters with the coughs, catches
// twice, then spins down to a windmill.
const ENGINE_FAILURE_RATE_CURVE = Object.freeze([1.12, 0.66, 1.02, 0.58, 0.9, 0.46, 0.72, 0.36, 0.28, 0.22]);
const ENGINE_FAILURE_CURVE_S = 2.4;

const SAMPLE_URLS = Object.freeze({
    airplaneEngine: station3dAssetUrl('audio/sfx/special-vehicles/airplane-propeller-loop.mp3'),
    boatEngine: station3dAssetUrl('audio/sfx/special-vehicles/boat-engine-loop.mp3'),
    boatWake: station3dAssetUrl('audio/sfx/special-vehicles/boat-wake-loop.mp3'),
});

const sampleBankByContext = new WeakMap();

// A film's mix of the flown aircraft's engine (core/film-engine-audio.js),
// neutral outside films. One flown aircraft at a time, so one mix.
let aircraftEngineFilmMix = NEUTRAL_ENGINE_MIX;

export function setAircraftEngineFilmMix(mix) {
    const gainScale = Number(mix?.gainScale);
    const rateScale = Number(mix?.rateScale);
    aircraftEngineFilmMix = Number.isFinite(gainScale) && Number.isFinite(rateScale)
        ? { gainScale, rateScale }
        : NEUTRAL_ENGINE_MIX;
}

export function aircraftEngineFilmMixNow() {
    return aircraftEngineFilmMix;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function disconnectQuietly(node) {
    try { node?.disconnect?.(); } catch (_) { /* already disconnected */ }
}

function stopQuietly(node, when) {
    try { node?.stop?.(when); } catch (_) { /* already stopped */ }
}

function loadSampleBank(ctx) {
    const existing = sampleBankByContext.get(ctx);
    if (existing) return existing;
    const promise = Promise.all(Object.entries(SAMPLE_URLS).map(async ([key, url]) => {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`special vehicle sample HTTP ${response.status}: ${url}`);
        return [key, await ctx.decodeAudioData(await response.arrayBuffer())];
    })).then(entries => Object.fromEntries(entries)).catch((error) => {
        sampleBankByContext.delete(ctx);
        throw error;
    });
    sampleBankByContext.set(ctx, promise);
    return promise;
}

function addLoop(graph, key, buffer) {
    const gain = graph.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(graph.output);
    const source = graph.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    graph.voices[key] = { source, gain };
}

function attachSamples(graph, buffers) {
    if (!graph || !buffers) return false;
    if (graph.kind === 'airplane') {
        addLoop(graph, 'engine', buffers.airplaneEngine);
    } else {
        addLoop(graph, 'engine', buffers.boatEngine);
        addLoop(graph, 'wake', buffers.boatWake);
    }
    graph.sampleState = 'ready';
    return true;
}

// Exported for tests: a fake graph asserts the engine-failure cue exactly once.
export function applyPose(graph, pose = {}) {
    if (!graph || graph.sampleState !== 'ready') return;
    const now = graph.ctx.currentTime;
    const speedMps = Math.abs(Number(pose.speedMps) || 0);
    const throttle = clamp01(pose.throttle);
    const engine = graph.voices.engine;
    if (graph.kind === 'airplane') {
        if (pose.engineFailed) {
            if (graph.engineFailure) return;
            graph.engineFailure = { atS: now };
            if (graph.lastEngineFailed === false) {
                // A running engine just quit: it coughs twice with the loop
                // stuttering under it, then winds down to the wind. The cue
                // routes past this graph's output so leaving the aircraft
                // mid-cough does not cut it off.
                graph.engineFailure.sputter = scheduleAircraftEngineSputterSfx(
                    graph.ctx,
                    getAudioDestination(graph.ctx) || graph.output,
                );
                const rate = engine.source.playbackRate;
                rate.cancelScheduledValues?.(now);
                if (typeof rate.setValueCurveAtTime === 'function') {
                    rate.setValueCurveAtTime(new Float32Array(ENGINE_FAILURE_RATE_CURVE), now, ENGINE_FAILURE_CURVE_S);
                } else {
                    rate.setTargetAtTime(0.22, now, 0.9);
                }
                engine.gain.gain.cancelScheduledValues?.(now);
                engine.gain.gain.setValueAtTime?.(engine.gain.gain.value, now);
                engine.gain.gain.setTargetAtTime(0, now + 1.7, 0.45);
                return;
            }
            // A resumed checkpoint whose engine was already dead: only the
            // wind is left. The idle floor below would keep it humming.
            engine.gain.gain.setTargetAtTime(0, now, 0.3);
            engine.source.playbackRate.setTargetAtTime(0.22, now, 0.5);
            return;
        }
        graph.lastEngineFailed = false;
        const mix = aircraftEngineFilmMix;
        const levels = specialVehicleAudioMix({ kind: 'airplane', speedMps, throttle });
        engine.gain.gain.setTargetAtTime(levels.engineGain * mix.gainScale, now, 0.09);
        engine.source.playbackRate.setTargetAtTime(levels.engineRate * mix.rateScale, now, 0.08);
        return;
    }
    const levels = specialVehicleAudioMix({ kind: 'boat', speedMps, throttle });
    engine.gain.gain.setTargetAtTime(levels.engineGain, now, 0.1);
    engine.source.playbackRate.setTargetAtTime(levels.engineRate, now, 0.09);
    const wake = graph.voices.wake;
    wake.gain.gain.setTargetAtTime(levels.wakeGain, now, 0.12);
    wake.source.playbackRate.setTargetAtTime(levels.wakeRate, now, 0.12);
}

export function createGtaSpecialVehicleAudio({ ensureContext } = {}) {
    let graph = null;
    let kind = null;
    let running = false;
    let lastPose = null;

    function initialize() {
        if (!running || graph) return !!graph;
        const ctx = typeof ensureContext === 'function' ? ensureContext() : null;
        const destination = ctx && ctx.state !== 'closed' ? getAudioDestination(ctx) : null;
        if (!ctx || !destination) return false;
        const output = ctx.createGain();
        output.gain.value = 1;
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -22;
        compressor.ratio.value = 4;
        output.connect(compressor);
        compressor.connect(destination);
        graph = {
            ctx,
            kind,
            output,
            compressor,
            voices: {},
            sampleState: 'loading',
            // null until the first pose says whether the engine runs, so a
            // checkpoint resumed engine-out never plays the failure cue.
            lastEngineFailed: null,
            engineFailure: null,
        };
        const initializedGraph = graph;
        loadSampleBank(ctx).then((buffers) => {
            if (!running || graph !== initializedGraph) return;
            attachSamples(initializedGraph, buffers);
            applyPose(initializedGraph, lastPose);
        }).catch((error) => {
            if (graph !== initializedGraph) return;
            initializedGraph.sampleState = 'failed';
            console.warn('[gta-special-vehicle-audio] recorded samples unavailable', error);
        });
        return true;
    }

    function stopGraph() {
        const current = graph;
        graph = null;
        if (!current) return;
        const now = current.ctx.currentTime;
        current.output.gain.cancelScheduledValues(now);
        current.output.gain.setTargetAtTime(0, now, 0.04);
        const stopAt = now + 0.2;
        for (const voice of Object.values(current.voices)) stopQuietly(voice.source, stopAt);
        setTimeout(() => {
            for (const voice of Object.values(current.voices)) {
                disconnectQuietly(voice.source);
                disconnectQuietly(voice.gain);
            }
            disconnectQuietly(current.output);
            disconnectQuietly(current.compressor);
        }, 260);
    }

    return {
        start(nextKind) {
            const normalized = nextKind === 'airplane' ? 'airplane' : 'boat';
            if (running && kind === normalized) return;
            stopGraph();
            kind = normalized;
            running = true;
            lastPose = null;
            initialize();
        },
        update(pose) {
            lastPose = pose || null;
            if (!running) return;
            if (!initialize() || !graph) return;
            applyPose(graph, lastPose);
        },
        stop() {
            running = false;
            lastPose = null;
            stopGraph();
        },
        dispose() {
            running = false;
            lastPose = null;
            stopGraph();
        },
        debugState() {
            return {
                running,
                kind,
                initialized: !!graph,
                sampleState: graph?.sampleState || 'inactive',
                voices: graph ? Object.keys(graph.voices).length : 0,
                engineFailure: graph?.engineFailure ? { sputtered: !!graph.engineFailure.sputter } : null,
                engineGain: graph?.voices?.engine?.gain?.gain?.value ?? null,
                engineRate: graph?.voices?.engine?.source?.playbackRate?.value ?? null,
                filmMix: kind === 'airplane' ? aircraftEngineFilmMix : null,
            };
        },
    };
}
