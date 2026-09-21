// Synthesised lift sounds. All nodes share Station3D's unlocked destination;
// keeping sources in a set makes session teardown immediate and leak-free.
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { liftSoundCue } from '../core/lift-sound-cues.js';

let context = null;
const activeSources = new Set();

function startOscillator(c, frequency, endFrequency, duration, gainValue, when) {
    const oscillator = c.createOscillator();
    const gain = c.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), when + duration);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), when + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(gain);
    gain.connect(getAudioDestination(c));
    oscillator.onended = () => {
        activeSources.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
    };
    activeSources.add(oscillator);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
}

function ensureContext() {
    if (!context || context.state === 'closed') context = createUnlockedAudioContext();
    if (context) resumeUnlockedAudioContext(context);
    return context;
}

export function playLiftDoorSound({ phase = 'opening' } = {}) {
    if (liftSoundCue(phase) !== 'door-slide') return false;
    const c = ensureContext();
    if (!c) return false;
    const when = c.currentTime + 0.005;
    // Two quiet detuned sweeps read as a motor and guide rail without an asset.
    startOscillator(c, phase === 'closing' ? 180 : 120, phase === 'closing' ? 95 : 260, 0.42, 0.075, when);
    startOscillator(c, phase === 'closing' ? 242 : 161, phase === 'closing' ? 128 : 350, 0.42, 0.035, when);
    return true;
}

export function playLiftArrivalSound({ phase = 'arrival-opening' } = {}) {
    if (liftSoundCue(phase) !== 'arrival-chime') return false;
    const c = ensureContext();
    if (!c) return false;
    const when = c.currentTime + 0.005;
    startOscillator(c, 523.25, 523.25, 0.34, 0.09, when);
    startOscillator(c, 783.99, 783.99, 0.46, 0.075, when + 0.12);
    return true;
}

export function stopLiftSounds() {
    for (const source of activeSources) {
        try { source.stop(); } catch (_) { /* already stopped */ }
    }
    activeSources.clear();
}
