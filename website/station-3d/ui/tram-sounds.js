// Procedural tram sound layers for the cab: an always-on rolling hum and a
// curve-driven flange squeal (speed/curvature derived from pose deltas), plus
// event cues — door open/close cycles on stops, a Zagreb "ding-ding" bell, and
// a stereo-panned bed for the nearest other tram. All synthesis, no samples;
// started/stopped with the cab session, safe to update every frame.

import { haversineMeters, bearingDeg, DEG_TO_RAD } from '../core/math.js';
import { isWorldBuilding } from '../core/world-ready.js';
import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

// Bed gains stay ≤0.03 (ambient); transients sit at ~0.12–0.3.
const ROLLING_MAX_GAIN   = 0.022;
const SQUEAL_MAX_GAIN     = 0.035;
const OTHER_MAX_GAIN      = 0.03;
const GAIN_SMOOTH         = 0.18;   // rolling-hum gain time constant (s)
const PITCH_SMOOTH        = 0.08;   // rolling filter/playbackRate time constant
const SPEED_SMOOTH        = 0.35;   // seconds toward new speed value
const KAPPA_SMOOTH        = 0.10;   // curvature smoothing time constant (s)
const SQUEAL_ATTACK       = 0.25;   // fast-ish rise into a squeal
const SQUEAL_RELEASE      = 0.60;   // slower fall out of it
const OTHER_UPDATE_MS     = 250;    // nearest-tram sub-update throttle (4 Hz)
const OTHER_MAX_DIST_M    = 80;     // audible radius for another tram
const OTHER_GAIN_SMOOTH   = 0.30;
const OTHER_PAN_SMOOTH    = 0.20;
const BELL_MIN_INTERVAL_MS = 400;   // rate-limit to one ring per 0.4 s
const SQUEAL_CENTRE_HZ    = 2500;   // bandpass centre; LFO wanders ±600 (1900–3100)
const SQUEAL_LFO_HZ       = 0.30;
const SQUEAL_LFO_SWING    = 600;

let ctx = null;
let running = false;
let unlockCancel = null;
let noiseBuffer = null;

// Persistent bed nodes.
let rollingSource = null, rollingFilter = null, rollingGain = null;
let squealSource = null, squealFilter = null, squealGain = null, squealLfo = null, squealLfoGain = null;
let otherSource = null, otherFilter = null, otherGain = null, otherPan = null;

// Motion tracking (pose-derived, like engine-whine).
let lastLat = null, lastLon = null, lastHeadingRad = null, lastSampleMs = 0;
let smoothedSpeedKmh = 0, smoothedKappa = 0, prevSquealBase = 0;

// Event rate-limits / throttles.
let lastBellMs = -10000;
let lastOtherUpdateMs = 0;

function perfNow() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
}

function resetMotionTracking() {
    lastLat = null;
    lastLon = null;
    lastHeadingRad = null;
    lastSampleMs = 0;
    smoothedSpeedKmh = 0;
    smoothedKappa = 0;
    prevSquealBase = 0;
}

function makeNoiseBuffer(context, seconds) {
    const len = Math.ceil(context.sampleRate * seconds);
    const buf = context.createBuffer(1, len, context.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
}

function initTramSoundsAudio() {
    if (!running) return false;
    if (!ctx) ctx = createUnlockedAudioContext();
    if (!ctx) return false;
    resumeUnlockedAudioContext(ctx);
    if (rollingGain) return true;

    noiseBuffer = makeNoiseBuffer(ctx, 2);

    // ── Layer 1: rolling hum ─ looped noise → lowpass → gain ──────────
    rollingGain = ctx.createGain();
    rollingGain.gain.value = 0;
    rollingGain.connect(getAudioDestination(ctx));
    rollingFilter = ctx.createBiquadFilter();
    rollingFilter.type = 'lowpass';
    rollingFilter.frequency.value = 120;
    rollingFilter.Q.value = 0.5;
    rollingFilter.connect(rollingGain);
    rollingSource = ctx.createBufferSource();
    rollingSource.buffer = noiseBuffer;
    rollingSource.loop = true;
    rollingSource.connect(rollingFilter);
    rollingSource.start();

    // ── Layer 2: flange squeal ─ noise → bandpass (LFO-wandered) → gain ─
    squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    squealGain.connect(getAudioDestination(ctx));
    squealFilter = ctx.createBiquadFilter();
    squealFilter.type = 'bandpass';
    squealFilter.frequency.value = SQUEAL_CENTRE_HZ;
    squealFilter.Q.value = 8;
    squealFilter.connect(squealGain);
    squealSource = ctx.createBufferSource();
    squealSource.buffer = noiseBuffer;
    squealSource.loop = true;
    squealSource.connect(squealFilter);
    squealSource.start();
    // Slow LFO wanders the bandpass centre 1900–3100 Hz.
    squealLfo = ctx.createOscillator();
    squealLfo.type = 'sine';
    squealLfo.frequency.value = SQUEAL_LFO_HZ;
    squealLfoGain = ctx.createGain();
    squealLfoGain.gain.value = SQUEAL_LFO_SWING;
    squealLfo.connect(squealLfoGain).connect(squealFilter.frequency);
    squealLfo.start();

    // ── Layer 5: nearest-other-tram bed ─ noise → lowpass → gain → pan ─
    otherGain = ctx.createGain();
    otherGain.gain.value = 0;
    otherFilter = ctx.createBiquadFilter();
    otherFilter.type = 'lowpass';
    otherFilter.frequency.value = 300;
    otherFilter.Q.value = 0.7;
    otherSource = ctx.createBufferSource();
    otherSource.buffer = noiseBuffer;
    otherSource.loop = true;
    otherSource.connect(otherFilter).connect(otherGain);
    otherPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (otherPan) {
        otherGain.connect(otherPan).connect(getAudioDestination(ctx));
    } else {
        otherGain.connect(getAudioDestination(ctx));
    }
    otherSource.start();

    return true;
}

function queueTramSoundsInit() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        initTramSoundsAudio();
    });
}

export function startTramSounds() {
    if (running) return;
    running = true;
    if (!initTramSoundsAudio()) queueTramSoundsInit();
    resetMotionTracking();
    lastBellMs = -10000;
    lastOtherUpdateMs = 0;
}

function silenceBeds(now) {
    if (rollingGain) rollingGain.gain.setTargetAtTime(0, now, GAIN_SMOOTH);
    if (squealGain) squealGain.gain.setTargetAtTime(0, now, SQUEAL_RELEASE);
    if (otherGain) otherGain.gain.setTargetAtTime(0, now, OTHER_GAIN_SMOOTH);
}

export function updateTramSounds(pose, otherTrainsFn) {
    if (!running || !ctx || !pose) return;
    const status = pose.status || null;
    const now = ctx.currentTime;
    const nowMs = perfNow();

    // Silent during the loading hold (sim frozen, scene hidden) — same as walk mode.
    if (isWorldBuilding()) {
        silenceBeds(now);
        resetMotionTracking();
        return;
    }
    // Walk mode: mute every bed and forget motion so re-entry re-seeds cleanly.
    if (status && status.walkMode) {
        silenceBeds(now);
        resetMotionTracking();
        return;
    }
    if (!rollingGain) return;   // audio still building/locked

    // ── Derive speed + curvature from pose deltas (works for manual and
    //    autopilot alike). Mirrors engine-whine's haversine speed. ──────
    if (lastLat != null && lastSampleMs > 0) {
        const dtS = (nowMs - lastSampleMs) / 1000;
        if (dtS > 0 && dtS < 1) {
            const distM = haversineMeters(lastLat, lastLon, pose.lat, pose.lon);
            const instSpeedKmh = (distM / dtS) * 3.6;
            const aSpeed = 1 - Math.exp(-dtS / SPEED_SMOOTH);
            smoothedSpeedKmh += (instSpeedKmh - smoothedSpeedKmh) * aSpeed;

            const heading = (pose.headingDeg || 0) * DEG_TO_RAD;
            let dh = heading - lastHeadingRad;
            while (dh > Math.PI) dh -= 2 * Math.PI;
            while (dh < -Math.PI) dh += 2 * Math.PI;
            const instKappa = Math.abs(dh) / Math.max(0.5, distM);
            const aKappa = 1 - Math.exp(-dtS / KAPPA_SMOOTH);
            smoothedKappa += (instKappa - smoothedKappa) * aKappa;
        }
    }
    lastLat = pose.lat;
    lastLon = pose.lon;
    lastHeadingRad = (pose.headingDeg || 0) * DEG_TO_RAD;
    lastSampleMs = nowMs;

    const speed = Math.max(0, smoothedSpeedKmh);
    const paused = !!(status && status.paused);

    // ── Layer 1: rolling hum ──────────────────────────────────────────
    const rollingActive = !paused && speed >= 0.5;
    const rollingTarget = rollingActive
        ? Math.pow(Math.min(1, speed / 50), 1.3) * ROLLING_MAX_GAIN
        : 0;
    rollingGain.gain.setTargetAtTime(rollingTarget, now, GAIN_SMOOTH);
    rollingFilter.frequency.setTargetAtTime(120 + speed * 6, now, PITCH_SMOOTH);
    rollingSource.playbackRate.setTargetAtTime(0.85 + Math.min(1, speed / 50) * 0.5, now, PITCH_SMOOTH);

    // ── Layer 2: flange squeal ─ curvature-gated, asymmetric env ───────
    const squealFactor = clamp01((smoothedKappa - 0.008) / 0.05);
    const squealBase = speed < 5 ? 0 : squealFactor * Math.min(1, speed / 25) * SQUEAL_MAX_GAIN;
    const squealTc = squealBase > prevSquealBase ? SQUEAL_ATTACK : SQUEAL_RELEASE;
    prevSquealBase = squealBase;
    const flutter = 1 + 0.2 * Math.sin(2 * Math.PI * 6.3 * (nowMs / 1000));
    squealGain.gain.setTargetAtTime(squealBase * flutter, now, squealTc);

    // (Door open/close cues are triggered by the cab's door state machine
    // via the exported playDoorOpen/playDoorClose — no latch here.)

    // ── Layer 5: nearest other tram (throttled to 4 Hz) ───────────────
    if (otherPan && nowMs - lastOtherUpdateMs >= OTHER_UPDATE_MS) {
        lastOtherUpdateMs = nowMs;
        let targetGain = 0;
        let targetPan = 0;
        const list = otherTrainsFn ? otherTrainsFn() : null;
        if (list && list.length) {
            let bestDist = Infinity, bestLat = 0, bestLon = 0;
            for (let i = 0; i < list.length; i++) {
                const tr = list[i];
                if (!tr) continue;
                const d = haversineMeters(pose.lat, pose.lon, tr.lat, tr.lon);
                if (d < bestDist) { bestDist = d; bestLat = tr.lat; bestLon = tr.lon; }
            }
            if (bestDist <= OTHER_MAX_DIST_M) {
                targetGain = OTHER_MAX_GAIN * (1 - bestDist / OTHER_MAX_DIST_M);
                const bearingToTram = bearingDeg(pose.lat, pose.lon, bestLat, bestLon) * DEG_TO_RAD;
                const cameraHeading = (pose.headingDeg || 0) * DEG_TO_RAD;
                targetPan = clamp(Math.sin(bearingToTram - cameraHeading), -0.9, 0.9);
            }
        }
        otherGain.gain.setTargetAtTime(targetGain, now, OTHER_GAIN_SMOOTH);
        otherPan.pan.setTargetAtTime(targetPan, now, OTHER_PAN_SMOOTH);
    }
}

// Air-hiss burst: 0.4 s of noise through a highpass with a decaying envelope.
function playHiss(startAt, peak) {
    const dur = 0.4;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(peak, startAt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    src.connect(hp).connect(g).connect(getAudioDestination(ctx));
    const maxOffset = Math.max(0, noiseBuffer.duration - dur - 0.02);
    src.start(startAt, maxOffset > 0 ? Math.random() * maxOffset : 0, dur);
    src.stop(startAt + dur + 0.02);
}

// Single sine ping with a quick attack and exponential decay.
function playPing(freq, startAt, decay, peak) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);
    osc.connect(g).connect(getAudioDestination(ctx));
    osc.start(startAt);
    osc.stop(startAt + decay + 0.02);
}

// ARRIVAL cue: air hiss, then a two-tone chime a quarter-second later.
// Exported: the cab's door state machine triggers these on door edges.
export function playDoorOpen() {
    if (!ctx) return;
    const now = ctx.currentTime;
    playHiss(now, 0.12);
    playPing(987, now + 0.25, 0.4, 0.25);
    playPing(784, now + 0.25 + 0.18, 0.4, 0.25);
}

// DEPARTURE cue: three fast warning pings, then a closing hiss burst.
export function playDoorClose() {
    if (!ctx) return;
    const now = ctx.currentTime;
    playPing(660, now, 0.25, 0.2);
    playPing(660, now + 0.14, 0.25, 0.2);
    playPing(660, now + 0.28, 0.25, 0.2);
    playHiss(now + 0.42, 0.12);
}

// One inharmonic partial of a bell strike.
function bellPartial(freq, peak, startAt) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, startAt);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.7);
    osc.connect(g).connect(getAudioDestination(ctx));
    osc.start(startAt);
    osc.stop(startAt + 0.72);
}

function strikeBell(startAt) {
    bellPartial(1150, 0.3, startAt);
    bellPartial(1730, 0.12, startAt);
}

// Zagreb "ding-ding": two strikes 0.25 s apart. Works any time while running.
export function playTramBell() {
    if (!running) return;
    if (!ctx && !initTramSoundsAudio()) return;
    if (!ctx) return;
    const nowMs = perfNow();
    if (nowMs - lastBellMs < BELL_MIN_INTERVAL_MS) return;
    lastBellMs = nowMs;
    resumeUnlockedAudioContext(ctx);
    const now = ctx.currentTime;
    strikeBell(now);
    strikeBell(now + 0.25);
}

export function stopTramSounds() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    if (!running || !ctx) { running = false; return; }
    try {
        const now = ctx.currentTime;
        const stopAt = now + 0.25;
        if (rollingGain) rollingGain.gain.setTargetAtTime(0, now, 0.05);
        if (squealGain) squealGain.gain.setTargetAtTime(0, now, 0.05);
        if (otherGain) otherGain.gain.setTargetAtTime(0, now, 0.05);
        [rollingSource, squealSource, otherSource, squealLfo].forEach((s) => {
            if (!s) return;
            try { s.stop(stopAt); } catch (_) { /* ignore */ }
            try { s.disconnect(); } catch (_) { /* ignore */ }
        });
        [rollingFilter, squealFilter, squealLfoGain, otherFilter, otherPan,
            rollingGain, squealGain, otherGain].forEach((n) => {
            if (n) { try { n.disconnect(); } catch (_) { /* ignore */ } }
        });
    } catch (_) { /* ignore */ }
    rollingSource = rollingFilter = rollingGain = null;
    squealSource = squealFilter = squealGain = squealLfo = squealLfoGain = null;
    otherSource = otherFilter = otherGain = otherPan = null;
    running = false;
}
