// VVVF-style traction-motor whine for cab mode. Two sawtooth oscillators into
// a lowpass; pitch + filter cutoff track current speed (motor RPM), while
// gain tracks |acceleration| (motor torque). The result: silent at constant
// cruise and at rest, audible only when the driver is actively powering or
// braking — same envelope as a real tram inverter. Safe to call update every
// frame; started/stopped with the cab session.

import { haversineMeters } from '../core/math.js';
import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { isWorldBuilding } from '../core/world-ready.js';

const BASE_HZ         = 90;     // pitch at rest
const HZ_PER_KMH      = 3.5;    // +350 Hz across 0→100 km/h
const FILTER_BASE_HZ  = 280;
const FILTER_PER_KMH  = 10;
const MAX_GAIN        = 0.025;  // quiet — ambient layer, never in-your-face
// |Δspeed/Δt| in km/h per second that drives gain to MAX_GAIN. Real trams
// brake/accelerate at ~1 m/s² ≈ 3.6 km/h/s, so 3 saturates the volume on
// any committed throttle/brake while idle wobble stays inaudible.
const ACCEL_FULL_KMHPS = 3.0;
// Idle gain at constant cruise. 0 = strict silence when accel is zero;
// raise slightly (e.g. 0.05) for a faint always-on rolling rumble.
const IDLE_GAIN_FRAC   = 0.0;
const SPEED_SMOOTH    = 0.35;   // seconds toward new speed value
const ACCEL_SMOOTH    = 0.45;   // accel jitters more than speed → smooth harder
const GAIN_SMOOTH     = 0.18;
const PITCH_SMOOTH    = 0.08;

let ctx = null;
let masterGain = null;
let filter = null;
let osc1 = null;
let osc2 = null;
let running = false;
let unlockCancel = null;

let lastLat = null;
let lastLon = null;
let lastSampleMs = 0;
let smoothedSpeedKmh = 0;
let smoothedAccelKmhps = 0;

function resetMotionTracking() {
    lastLat = null;
    lastLon = null;
    lastSampleMs = 0;
    smoothedSpeedKmh = 0;
    smoothedAccelKmhps = 0;
}

function initEngineWhineAudio() {
    if (!running) return false;
    if (!ctx) ctx = createUnlockedAudioContext();
    if (!ctx) return false;
    resumeUnlockedAudioContext(ctx);
    if (masterGain && filter && osc1 && osc2) return true;

    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(getAudioDestination(ctx));

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_BASE_HZ;
    filter.Q.value = 0.7;  // no resonant peak — avoids harshness
    filter.connect(masterGain);

    osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = BASE_HZ;
    osc1.connect(filter);

    osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = BASE_HZ * 0.5;  // an octave below — warmer body
    osc2.connect(filter);

    osc1.start();
    osc2.start();
    return true;
}

function queueEngineWhineInit() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        initEngineWhineAudio();
    });
}

export function startEngineWhine() {
    if (running) return;
    running = true;
    if (!initEngineWhineAudio()) queueEngineWhineInit();

    resetMotionTracking();
}

export function updateEngineWhine(pose) {
    if (!running || !ctx || !pose) return;
    // Silent during the loading hold: the sim is frozen and the scene hidden, so
    // the idle-torque whine floor (IDLE_GAIN_FRAC) would otherwise drone under the
    // overlay. Reset motion so reveal doesn't spike gain on the frozen→moving jump.
    if (isWorldBuilding()) {
        resetMotionTracking();
        masterGain.gain.setTargetAtTime(0, ctx.currentTime, GAIN_SMOOTH);
        return;
    }
    if (pose.status && pose.status.walkMode) {
        resetMotionTracking();
        const now = ctx.currentTime;
        masterGain.gain.setTargetAtTime(0, now, GAIN_SMOOTH);
        return;
    }

    // Derive speed from lat/lon deltas — works for both autopilot (no speed
    // field) and driver mode. Silent while paused at stations.
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const prevSampleMs = lastSampleMs;
    let instSpeedKmh = 0;
    if (lastLat != null && prevSampleMs > 0) {
        const dt = (nowMs - prevSampleMs) / 1000;
        if (dt > 0 && dt < 1) {
            const meters = haversineMeters(lastLat, lastLon, pose.lat, pose.lon);
            instSpeedKmh = (meters / dt) * 3.6;
            // Clamp to a realistic rail speed so a one-frame position jump (e.g. a
            // terminus turnaround that switches tracks) can't pitch the whine to an
            // absurd frequency (the BiquadFilter "outside nominal range" warnings).
            if (instSpeedKmh > 130) instSpeedKmh = 130;
        }
    }
    lastLat = pose.lat;
    lastLon = pose.lon;
    lastSampleMs = nowMs;

    const active = pose.status && !pose.status.paused;
    const target = active ? instSpeedKmh : 0;

    // Simple exponential smoothing so frame-to-frame jitter doesn't warble.
    const alphaSpeed = 1 - Math.exp(-0.05 / SPEED_SMOOTH);
    const prevSpeed = smoothedSpeedKmh;
    smoothedSpeedKmh += (target - smoothedSpeedKmh) * alphaSpeed;
    const speed = Math.max(0, smoothedSpeedKmh);

    // Acceleration in km/h per second, derived from smoothed speed so the
    // frame-rate jitter that already plagues raw speed doesn't get
    // double-amplified by the d/dt. Smooth again because accel is still
    // noisier than speed (it's a derivative).
    const dtFrame = prevSampleMs > 0 ? (nowMs - prevSampleMs) / 1000 : 0;
    const instAccel = dtFrame > 0 && dtFrame < 1 ? (smoothedSpeedKmh - prevSpeed) / dtFrame : 0;
    const alphaAccel = 1 - Math.exp(-0.05 / ACCEL_SMOOTH);
    smoothedAccelKmhps += (instAccel - smoothedAccelKmhps) * alphaAccel;

    const now = ctx.currentTime;
    const pitch = BASE_HZ + speed * HZ_PER_KMH;
    osc1.frequency.setTargetAtTime(pitch, now, PITCH_SMOOTH);
    osc2.frequency.setTargetAtTime(pitch * 0.5, now, PITCH_SMOOTH);
    filter.frequency.setTargetAtTime(FILTER_BASE_HZ + speed * FILTER_PER_KMH, now, PITCH_SMOOTH);

    // |accel| → 0..1, regardless of sign (acceleration and braking sound
    // the same on a real VVVF inverter; only torque magnitude matters).
    const accelMag = Math.min(1, Math.abs(smoothedAccelKmhps) / ACCEL_FULL_KMHPS);
    const gainFrac = active ? Math.max(IDLE_GAIN_FRAC, accelMag) : 0;
    masterGain.gain.setTargetAtTime(gainFrac * MAX_GAIN, now, GAIN_SMOOTH);
}

export function stopEngineWhine() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    if (!running || !ctx) { running = false; return; }
    try {
        const now = ctx.currentTime;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setTargetAtTime(0, now, 0.05);
        const stopAt = now + 0.25;
        osc1.stop(stopAt);
        osc2.stop(stopAt);
        osc1.disconnect();
        osc2.disconnect();
        filter.disconnect();
        masterGain.disconnect();
    } catch (_) { /* ignore */ }
    osc1 = null;
    osc2 = null;
    filter = null;
    masterGain = null;
    running = false;
}
