// Owns the restrained procedural pad under campaign cinematics. The graph is
// routed through the shared mute boundary and schedules all movement up front,
// so it adds no recurring main-thread work to the renderer loop.

import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';

const SCORE_GAIN = 0.036;
const SILENCE = 0.0001;
const ROOT_FREQUENCIES = Object.freeze({
    'adriatic-crossing': 73.42,
    'train-to-lika': 65.41,
    'train-to-zagreb': 73.42,
    'permit-reveal': 82.41,
    'tower-construction': 55.00,
});
const VOICES = Object.freeze([
    Object.freeze({ ratio: 1, type: 'sine', gain: 0.72 }),
    Object.freeze({ ratio: 1.5, type: 'sine', gain: 0.34 }),
    Object.freeze({ ratio: 2, type: 'triangle', gain: 0.12 }),
]);
const HARMONIC_PATH = Object.freeze([1, 4 / 3, 3 / 2, 1]);

let audioContext = null;
let currentScore = null;

function finiteDurationSeconds(cinematic) {
    return Math.max(4, Math.min(120, (Number(cinematic?.durationMs) || 0) / 1000));
}

function rootFrequency(cinematic) {
    return ROOT_FREQUENCIES[cinematic?.id] || 65.41;
}

export function scheduleCampaignCinematicScore(
    ctx,
    destination,
    cinematic,
    startTime = ctx?.currentTime || 0,
) {
    if (!ctx || !destination) return null;
    const durationS = finiteDurationSeconds(cinematic);
    const endTime = startTime + durationS;
    const fadeInS = Math.min(1.6, durationS * 0.18);
    const fadeOutS = Math.min(2.2, durationS * 0.2);
    const master = ctx.createGain();
    master.gain.setValueAtTime(SILENCE, startTime);
    master.gain.exponentialRampToValueAtTime(SCORE_GAIN, startTime + fadeInS);
    master.gain.setValueAtTime(SCORE_GAIN, Math.max(startTime + fadeInS, endTime - fadeOutS));
    master.gain.exponentialRampToValueAtTime(SILENCE, endTime);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 720;
    lowpass.Q.value = 0.65;
    master.connect(lowpass).connect(destination);

    const oscillators = [];
    const voiceGains = [];
    const rootHz = rootFrequency(cinematic);
    for (const voice of VOICES) {
        const oscillator = ctx.createOscillator();
        oscillator.type = voice.type;
        oscillator.frequency.setValueAtTime(rootHz * voice.ratio, startTime);
        for (let step = 1; step < HARMONIC_PATH.length; step += 1) {
            oscillator.frequency.setTargetAtTime(
                rootHz * voice.ratio * HARMONIC_PATH[step],
                startTime + durationS * (step / HARMONIC_PATH.length),
                0.62,
            );
        }
        const gain = ctx.createGain();
        gain.gain.value = voice.gain;
        oscillator.connect(gain).connect(master);
        oscillator.start(startTime);
        oscillator.stop(endTime + 0.04);
        oscillators.push(oscillator);
        voiceGains.push(gain);
    }

    let stopped = false;
    const disconnect = () => {
        for (const node of [...oscillators, ...voiceGains, master, lowpass]) {
            try { node.disconnect?.(); } catch (_) {}
        }
    };
    oscillators.at(-1).onended = disconnect;

    return {
        oscillatorCount: oscillators.length,
        stop({ fadeSeconds = 0.55 } = {}) {
            if (stopped) return false;
            stopped = true;
            const now = Math.max(startTime, Number(ctx.currentTime) || startTime);
            const stopAt = now + Math.max(0.04, Math.min(1.4, Number(fadeSeconds) || 0));
            try {
                master.gain.cancelScheduledValues(now);
                master.gain.setValueAtTime(
                    Math.max(SILENCE, Number(master.gain.value) || SCORE_GAIN),
                    now,
                );
                master.gain.exponentialRampToValueAtTime(SILENCE, stopAt);
            } catch (_) {}
            for (const oscillator of oscillators) {
                try { oscillator.stop(stopAt + 0.04); } catch (_) {}
            }
            return true;
        },
    };
}

export function playCampaignCinematicScore(cinematic) {
    currentScore?.stop({ fadeSeconds: 0.4 });
    if (!audioContext) audioContext = createUnlockedAudioContext();
    if (!audioContext || !resumeUnlockedAudioContext(audioContext)) return null;
    const score = scheduleCampaignCinematicScore(
        audioContext,
        getAudioDestination(audioContext),
        cinematic,
        audioContext.currentTime,
    );
    if (!score) return null;
    const controller = {
        stop(options) {
            if (currentScore === controller) currentScore = null;
            return score.stop(options);
        },
    };
    currentScore = controller;
    return controller;
}
