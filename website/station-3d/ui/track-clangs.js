// Track-joint clangs. Fires only at rail geometry events: abrupt/accumulated
// direction changes and upcoming driver-mode switches. Each front-bogie hit
// queues a delayed rear-bogie hit once the tram has moved BOGIE_GAP_M.

import { haversineMeters } from '../core/math.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

const BOGIE_GAP_M             = 15;     // Zagreb tram bogie wheelbase, approx.
const HEADING_THRESHOLD_DEG   = 3;      // per-frame heading snap above this = joint
const HEADING_ACCUM_DEG       = 5.5;    // catches a bend split over several frames
const HEADING_FRAME_FLOOR_DEG = 0.25;   // ignore straight-track numeric wobble
const MIN_SPEED_KMH           = 3;      // ignore wobble at near-rest
const COOLDOWN_S              = 0.05;   // suppress duplicate triggers same instant
const SWITCH_TRIGGER_M        = 9;      // hit just before the front bogie enters a switch
const SWITCH_RESET_M          = 18;     // re-arm once the next switch is clearly separate
const REAR_EVENT_TTL_S        = 18;     // low-speed rear bogie can take >8s to arrive
const SAMPLE_DEFS = [
    {
        id: 'contact',
        url: station3dAssetUrl('audio/sfx/track-clang/tram-track-contact.mp3'),
        gain: 0.34,
        minDuration: 0.24,
        maxDuration: 0.46,
        randomOffset: true,
        filter: 'bandpass',
        frequency: 780,
        q: 0.8,
    },
    {
        id: 'impact',
        url: station3dAssetUrl('audio/sfx/track-clang/metal-impact.mp3'),
        gain: 0.28,
        minDuration: 0.18,
        maxDuration: 0.42,
        randomOffset: false,
        filter: 'lowpass',
        frequency: 1900,
        q: 0.7,
    },
    {
        id: 'ping',
        url: station3dAssetUrl('audio/sfx/track-clang/clang-ping.mp3'),
        gain: 0.14,
        minDuration: 0.12,
        maxDuration: 0.30,
        randomOffset: false,
        filter: 'highpass',
        frequency: 320,
        q: 0.7,
    },
];

let ctx = null;
let running = false;
let samplesStarted = false;
const sampleBuffers = [];

let lastLat = null;
let lastLon = null;
let lastHeadingRad = null;
let lastMs = 0;
let lastTriggerS = -10;
let pendingRear = [];   // [{ fromLat, fromLon, severity, queuedAt }]
let accumulatedHeadingDeg = 0;
let distanceSinceHeadingEventM = 0;
let switchArmed = true;
let unlockCancel = null;

function resetMotionTracking(pose, nowMs) {
    lastLat = pose ? pose.lat : null;
    lastLon = pose ? pose.lon : null;
    lastHeadingRad = pose ? (pose.headingDeg || 0) * Math.PI / 180 : null;
    lastMs = nowMs || 0;
    pendingRear = [];
    accumulatedHeadingDeg = 0;
    distanceSinceHeadingEventM = 0;
    switchArmed = true;
}

function initTrackClangAudio() {
    if (!running) return false;
    if (!ctx) ctx = createUnlockedAudioContext();
    if (!ctx) return false;
    resumeUnlockedAudioContext(ctx);
    startLoadingSamples();
    return true;
}

function queueTrackClangInit() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        initTrackClangAudio();
    });
}

export function startTrackClangs() {
    if (running) return;
    running = true;
    if (!initTrackClangAudio()) queueTrackClangInit();
    resetMotionTracking(null, 0);
    lastTriggerS = -10;
}

export function updateTrackClangs(pose) {
    if (!running || !ctx || !pose || !pose.status) return;

    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (pose.status.walkMode) {
        resetMotionTracking(pose, nowMs);
        return;
    }
    const heading = (pose.headingDeg || 0) * Math.PI / 180;

    // First frame after start: just seed reference values.
    if (lastLat == null || lastHeadingRad == null) {
        lastLat = pose.lat;
        lastLon = pose.lon;
        lastHeadingRad = heading;
        lastMs = nowMs;
        return;
    }

    const dt = (nowMs - lastMs) / 1000;
    // Skip teleport-sized jumps (mode switches, tab refocus) — they would
    // produce spurious huge heading deltas.
    if (dt <= 0 || dt > 0.5) {
        lastLat = pose.lat;
        lastLon = pose.lon;
        lastHeadingRad = heading;
        lastMs = nowMs;
        return;
    }

    const distM = haversineMeters(lastLat, lastLon, pose.lat, pose.lon);
    const speedKmh = (distM / dt) * 3.6;

    // Wrap heading delta into (-π, π].
    let dh = heading - lastHeadingRad;
    while (dh >  Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const dhDeg = Math.abs(dh) * 180 / Math.PI;

    const nowS = nowMs / 1000;
    tickHeadingEvent(dhDeg, distM, speedKmh, pose, nowS);
    tickSwitchEvent(pose.status.upcomingSwitch, speedKmh, pose, nowS);

    if (
        dhDeg >= HEADING_THRESHOLD_DEG &&
        speedKmh >= MIN_SPEED_KMH &&
        (nowS - lastTriggerS) >= COOLDOWN_S
    ) {
        const intensity = Math.max(0.65, Math.min(1.45,
            0.68 + (dhDeg - HEADING_THRESHOLD_DEG) / 9 + Math.min(speedKmh, 45) / 95));
        triggerTrackJoint(pose, nowS, intensity);
        accumulatedHeadingDeg = 0;
        distanceSinceHeadingEventM = 0;
    }

    // Fire any queued rear-bogie clangs once the tram has moved BOGIE_GAP_M
    // past the recorded joint position.
    if (pendingRear.length > 0) {
        const survivors = [];
        for (const ev of pendingRear) {
            const travelled = haversineMeters(ev.fromLat, ev.fromLon, pose.lat, pose.lon);
            // Drop stale events (pose teleported, or enough time passed
            // without enough travel).
            if (nowS - ev.queuedAt > REAR_EVENT_TTL_S) continue;
            if (travelled >= BOGIE_GAP_M) {
                playClang(ev.intensity || 0.85);
            } else {
                survivors.push(ev);
            }
        }
        pendingRear = survivors;
    }

    lastLat = pose.lat;
    lastLon = pose.lon;
    lastHeadingRad = heading;
    lastMs = nowMs;
}

export function stopTrackClangs() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    running = false;
    resetMotionTracking(null, 0);
}

function intensityForSpeed(speedKmh) {
    return Math.max(0.56, Math.min(1.05, 0.50 + Math.min(speedKmh, 55) / 100));
}

function triggerTrackJoint(pose, nowS, intensity) {
    if ((nowS - lastTriggerS) < COOLDOWN_S) return;
    playClang(intensity);
    pendingRear.push({
        fromLat: pose.lat,
        fromLon: pose.lon,
        intensity: intensity * 0.88,
        queuedAt: nowS,
    });
    lastTriggerS = nowS;
}

function tickHeadingEvent(dhDeg, distM, speedKmh, pose, nowS) {
    if (speedKmh < MIN_SPEED_KMH || distM <= 0) {
        accumulatedHeadingDeg = 0;
        distanceSinceHeadingEventM = 0;
        return;
    }

    distanceSinceHeadingEventM += distM;
    if (dhDeg >= HEADING_FRAME_FLOOR_DEG) {
        accumulatedHeadingDeg += dhDeg;
    } else {
        accumulatedHeadingDeg *= 0.82;
    }

    if (accumulatedHeadingDeg >= HEADING_ACCUM_DEG && distanceSinceHeadingEventM >= 2.5) {
        const intensity = Math.max(0.62, Math.min(1.30,
            0.62 + accumulatedHeadingDeg / 18 + Math.min(speedKmh, 45) / 110));
        triggerTrackJoint(pose, nowS, intensity);
        accumulatedHeadingDeg = 0;
        distanceSinceHeadingEventM = 0;
    }
}

function tickSwitchEvent(upcomingSwitch, speedKmh, pose, nowS) {
    if (!upcomingSwitch) {
        switchArmed = true;
        return;
    }
    const distM = Number(upcomingSwitch.distM);
    if (!Number.isFinite(distM)) return;
    if (distM > SWITCH_RESET_M) switchArmed = true;
    if (switchArmed && distM <= SWITCH_TRIGGER_M && speedKmh >= MIN_SPEED_KMH) {
        triggerTrackJoint(pose, nowS, intensityForSpeed(speedKmh) * 0.9);
        switchArmed = false;
    }
}

function startLoadingSamples() {
    if (samplesStarted || !ctx) return;
    samplesStarted = true;
    SAMPLE_DEFS.forEach((def, idx) => {
        fetch(def.url)
            .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`track clang fetch ${r.status}`)))
            .then(ab => ctx.decodeAudioData(ab))
            .then(buffer => { sampleBuffers[idx] = { def, buffer }; })
            .catch(err => console.warn('[track-clangs] sample load failed:', def.url, err.message));
    });
}

function randomBetween(a, b) {
    return a + Math.random() * (b - a);
}

function playSample(sample, intensity) {
    if (!sample || !sample.buffer) return false;
    const { def, buffer } = sample;
    const now = ctx.currentTime;
    const maxDuration = Math.min(def.maxDuration, Math.max(0.08, buffer.duration));
    const duration = Math.min(buffer.duration, randomBetween(def.minDuration, maxDuration));
    const maxOffset = Math.max(0, buffer.duration - duration - 0.02);
    const offset = def.randomOffset && maxOffset > 0 ? Math.random() * maxOffset : 0;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = randomBetween(0.86, 1.14);

    const filter = ctx.createBiquadFilter();
    filter.type = def.filter;
    filter.frequency.value = def.frequency * randomBetween(0.88, 1.16);
    filter.Q.value = def.q;

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = randomBetween(-0.12, 0.12);

    const g = ctx.createGain();
    const peak = def.gain * intensity * randomBetween(0.80, 0.98);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.006);
    g.gain.setTargetAtTime(0, now + duration * 0.52, 0.055);

    src.connect(filter);
    if (pan) {
        filter.connect(pan).connect(g).connect(getAudioDestination(ctx));
    } else {
        filter.connect(g).connect(getAudioDestination(ctx));
    }
    src.start(now, offset, duration);
    src.stop(now + duration + 0.08);
    return true;
}

function playRecordedClang(intensity) {
    const ready = sampleBuffers.filter(Boolean);
    if (ready.length === 0) return false;

    const contact = ready.find(sample => sample.def.id === 'contact');
    const impact = ready.find(sample => sample.def.id === 'impact');
    const ping = ready.find(sample => sample.def.id === 'ping');

    let played = false;
    if (contact) played = playSample(contact, intensity) || played;
    if (impact && Math.random() < 0.72) played = playSample(impact, intensity) || played;
    if (ping && Math.random() < 0.22) played = playSample(ping, intensity * 0.72) || played;
    return played;
}

// Heavy-tram-on-rails clunk: a low-frequency thump for the wheelset mass,
// plus a dull generated ring only when recorded samples are not ready yet.
function playClang(intensity = 1) {
    if (!ctx || ctx.state === 'closed') return;
    resumeUnlockedAudioContext(ctx);
    const recorded = playRecordedClang(intensity);
    playProceduralThump(intensity, recorded ? 0.04 : 1.0);
    if (!recorded) playProceduralRing(intensity);
}

function playProceduralThump(intensity, scale) {
    const now = ctx.currentTime;

    // ── Bass thump ─ pitch-dropping square at sub-bass range, ~0.4 s ──
    const thumpDur = 0.40;
    const thump = ctx.createOscillator();
    thump.type = 'square';
    thump.frequency.setValueAtTime(95, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.10);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0, now);
    // Soft attack — 8 ms ramp instead of an instant onset, kills the
    // "click" character that read as a firecracker.
    thumpGain.gain.linearRampToValueAtTime(0.42 * intensity * scale, now + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + thumpDur);
    thump.connect(thumpGain).connect(getAudioDestination(ctx));
    thump.start(now);
    thump.stop(now + thumpDur + 0.02);
}

function playProceduralRing(intensity) {
    const now = ctx.currentTime;

    // ── Metallic body ─ lowpass-noise tail, dull but present ──────────
    const bodyDur = 0.55;
    const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * bodyDur), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    // Sweep the lowpass DOWN over the decay so the timbre dulls as it
    // dies — mimics resonance bleeding off in a steel structure.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, now);
    lp.frequency.exponentialRampToValueAtTime(250, now + bodyDur);
    lp.Q.value = 1.2;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);
    noiseGain.gain.linearRampToValueAtTime(0.12 * intensity, now + 0.012);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + bodyDur);
    noise.connect(lp).connect(noiseGain).connect(getAudioDestination(ctx));
    noise.start(now);
    noise.stop(now + bodyDur + 0.05);
}
