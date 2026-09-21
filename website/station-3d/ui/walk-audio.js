// Footstep + water-wade + jetpack audio for walk mode.
//
//   Footsteps — synthesised: a short low thump + soft noise click. Triggered every
//   STEP_DISTANCE_M of horizontal travel, so cadence scales naturally
//   with walk speed. Suppressed while airborne (you don't step on air).
//
//   Water wade — recorded Mixkit SFX:
//     * "Footsteps in deep mud" (movement loop)
//     * "Jump into the water"   (entry splash)
//   Used only while the player is moving through water.
//
//   Jetpack — sustained filtered-noise whoosh that fades in while held
//   and fades out on release.
//
// All sound modules in this app share the convention:
//   start*()   — lazily creates the AudioContext + audio graph
//   stop*()    — disconnects nodes, releases resources
//   update*()  — per-frame; safe to call every frame, no-op when stopped

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';
import { station3dAssetUrl } from '../core/asset-url.js';

const STEP_DISTANCE_M = 1.6;     // one step every 1.6 m of horizontal travel
// At very high walk speeds the raw distance-based cadence can exceed a
// plausible footstep rate and collapse into a buzzy stream of transients.
// Cap the cadence here by stretching the effective step length with speed.
const STEP_INTERVAL_MIN_S = 0.16;
const FOOTSTEP_GAIN   = 0.06;    // soft — ambient layer
const FOOTSTEP_SCUFF_GAIN = FOOTSTEP_GAIN * 0.28;
const WATER_WADE_MAX_GAIN = 0.24;
const WATER_ENTRY_SPLASH_GAIN = 0.34;
const WATER_WADE_FADE_PER_S = 7;
const JETPACK_MAX_GAIN = 0.10;
const JETPACK_FADE_PER_S = 6;    // how fast jetpack gain ramps up/down
const WATER_WADE_LOOP_URL = station3dAssetUrl('audio/sfx/water-wade/deep-mud-loop.mp3');
const WATER_ENTRY_SPLASH_URL = station3dAssetUrl('audio/sfx/water-wade/entry-splash.mp3');

// ─── Footsteps ─────────────────────────────────────────────────────────────
let footCtx = null;
let footRunning = false;
let footAccumDistM = 0;
let footLastInWater = false;
// Pre-built noise buffer for the high-frequency click. Reused across all
// footstep instances; ~50 ms of white noise is plenty.
let footNoiseBuffer = null;
let waterLoadStarted = false;
let waterWadeLoopBuffer = null;
let waterEntrySplashBuffer = null;
let waterLoopSource = null;
let waterLoopGain = null;
let waterLoopCurrentGain = 0;
let waterLoopPlaybackRate = 0.9;
let waterLoopDesiredActive = false;
let footUnlockCancel = null;
const AUDIO_GAIN_EPSILON = 0.00001;
const AUDIO_RATE_EPSILON = 0.001;

function ensureWalkCtx() {
    if (!footCtx) footCtx = createUnlockedAudioContext();
    return footCtx;
}

function initFootAudio() {
    if (!footRunning) return false;
    if (!ensureWalkCtx()) return false;
    if (!footCtx) return false;
    resumeUnlockedAudioContext(footCtx);
    if (!footNoiseBuffer) {
        const len = Math.floor(footCtx.sampleRate * 0.05);
        footNoiseBuffer = footCtx.createBuffer(1, len, footCtx.sampleRate);
        const data = footNoiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    startLoadingWaterBuffers();
    return true;
}

function queueFootAudioInit() {
    bindGlobalAudioUnlock();
    if (footUnlockCancel) return;
    footUnlockCancel = whenAudioUnlocked(() => {
        footUnlockCancel = null;
        initFootAudio();
    });
}

export function startFootsteps() {
    if (footRunning) return;
    footRunning = true;
    footAccumDistM = 0;
    footLastInWater = false;
    if (!initFootAudio()) queueFootAudioInit();
}

export function stopFootsteps() {
    footRunning = false;
    if (footUnlockCancel) {
        footUnlockCancel();
        footUnlockCancel = null;
    }
    footAccumDistM = 0;
    footLastInWater = false;
    stopWaterLoop();
}

// Plays one footstep transient — short low thump + brief noise click.
function playFootstep() {
    if (!footCtx) return;
    const t = footCtx.currentTime;

    // Low thump: 80 Hz sine with fast attack + ~120 ms decay.
    const thump = footCtx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(60, t + 0.10);
    const thumpGain = footCtx.createGain();
    thumpGain.gain.setValueAtTime(0, t);
    thumpGain.gain.linearRampToValueAtTime(FOOTSTEP_GAIN, t + 0.005);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    thump.connect(thumpGain).connect(getAudioDestination(footCtx));
    thump.start(t);
    thump.stop(t + 0.15);

    // Noise click: short hi-passed burst that adds the "scuff" texture.
    const click = footCtx.createBufferSource();
    click.buffer = footNoiseBuffer;
    const clickHighpass = footCtx.createBiquadFilter();
    clickHighpass.type = 'highpass';
    clickHighpass.frequency.value = 700;
    clickHighpass.Q.value = 0.7;
    const clickLowpass = footCtx.createBiquadFilter();
    clickLowpass.type = 'lowpass';
    clickLowpass.frequency.value = 2600;
    clickLowpass.Q.value = 0.6;
    const clickGain = footCtx.createGain();
    clickGain.gain.setValueAtTime(0, t);
    clickGain.gain.linearRampToValueAtTime(FOOTSTEP_SCUFF_GAIN, t + 0.004);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    click.connect(clickHighpass).connect(clickLowpass).connect(clickGain).connect(getAudioDestination(footCtx));
    click.start(t);
    click.stop(t + 0.05);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function startLoadingWaterBuffers() {
    if (waterLoadStarted || !footCtx) return;
    waterLoadStarted = true;
    [
        ['loop', WATER_WADE_LOOP_URL],
        ['splash', WATER_ENTRY_SPLASH_URL],
    ].forEach(([kind, url]) => {
        fetch(url)
            .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`water audio fetch ${r.status}`)))
            .then(ab => footCtx.decodeAudioData(ab))
            .then(buffer => {
                if (kind === 'loop') {
                    waterWadeLoopBuffer = buffer;
                    if (footRunning && waterLoopDesiredActive) ensureWaterLoopPlaying();
                } else {
                    waterEntrySplashBuffer = buffer;
                }
            })
            .catch(err => console.warn('[walk-audio] water sample load failed:', url, err.message));
    });
}

function ensureWaterLoopPlaying() {
    if (!footCtx || !waterWadeLoopBuffer || waterLoopSource) return;
    if (!waterLoopGain) {
        waterLoopGain = footCtx.createGain();
        waterLoopGain.gain.value = 0;
        waterLoopGain.connect(getAudioDestination(footCtx));
    }
    const src = footCtx.createBufferSource();
    src.buffer = waterWadeLoopBuffer;
    src.loop = true;
    src.playbackRate.value = waterLoopPlaybackRate;
    src.connect(waterLoopGain);
    src.onended = () => {
        if (waterLoopSource === src) waterLoopSource = null;
    };
    src.start();
    waterLoopSource = src;
}

function stopWaterLoop() {
    if (waterLoopSource) {
        try { waterLoopSource.stop(); } catch (_) {}
        try { waterLoopSource.disconnect(); } catch (_) {}
        waterLoopSource = null;
    }
    if (waterLoopGain) {
        try { waterLoopGain.disconnect(); } catch (_) {}
        waterLoopGain = null;
    }
    waterLoopCurrentGain = 0;
    waterLoopPlaybackRate = 0.9;
    waterLoopDesiredActive = false;
}

function updateWaterLoop(speedMps, dt) {
    if (!footCtx) return;
    const active = Number.isFinite(speedMps) && speedMps > 0.08;
    waterLoopDesiredActive = active;
    if (active) ensureWaterLoopPlaying();
    if (!waterLoopGain) return;

    const targetGain = active
        ? WATER_WADE_MAX_GAIN * clamp(0.22 + speedMps / 4.8, 0.18, 1.0)
        : 0;
    const maxStep = WATER_WADE_FADE_PER_S * Math.max(0, dt || 0) * WATER_WADE_MAX_GAIN;
    if (maxStep > 0) {
        const delta = targetGain - waterLoopCurrentGain;
        if (Math.abs(delta) <= maxStep) waterLoopCurrentGain = targetGain;
        else waterLoopCurrentGain += Math.sign(delta) * maxStep;
    } else {
        waterLoopCurrentGain = targetGain;
    }
    if (Math.abs(waterLoopGain.gain.value - waterLoopCurrentGain) >= AUDIO_GAIN_EPSILON) {
        waterLoopGain.gain.setValueAtTime(waterLoopCurrentGain, footCtx.currentTime);
    }
    if (waterLoopSource && active) {
        const targetRate = clamp(0.82 + speedMps * 0.08, 0.82, 1.24);
        if (Math.abs(targetRate - waterLoopPlaybackRate) >= AUDIO_RATE_EPSILON) {
            waterLoopPlaybackRate = targetRate;
            waterLoopSource.playbackRate.setTargetAtTime(targetRate, footCtx.currentTime, 0.08);
        }
    }
    if (!active && waterLoopCurrentGain <= AUDIO_GAIN_EPSILON) {
        stopWaterLoop();
    }
}

function playWaterEntrySplash(intensity = 1) {
    if (!footCtx || !waterEntrySplashBuffer) return;
    const src = footCtx.createBufferSource();
    src.buffer = waterEntrySplashBuffer;
    src.playbackRate.value = clamp(0.9 + Math.random() * 0.16, 0.9, 1.1);

    const filter = footCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1900;

    const gain = footCtx.createGain();
    gain.gain.value = WATER_ENTRY_SPLASH_GAIN * clamp(intensity, 0.7, 1.25);

    const pan = footCtx.createStereoPanner ? footCtx.createStereoPanner() : null;
    if (pan) pan.pan.value = (Math.random() * 2 - 1) * 0.18;

    src.connect(filter);
    if (pan) filter.connect(pan).connect(gain).connect(getAudioDestination(footCtx));
    else filter.connect(gain).connect(getAudioDestination(footCtx));
    src.start();
}

function splashIntensityFromImpactSpeed(impactSpeedMps) {
    const speed = Number.isFinite(impactSpeedMps) ? impactSpeedMps : 0;
    return clamp(0.78 + speed / 7.5, 0.85, 1.25);
}

// Called per frame from the walk path. `horizontalDistM` is metres
// travelled this frame (set to 0 while airborne to suppress steps).
export function updateFootsteps(horizontalDistM, dt, inWater = false) {
    if (!footRunning) return;
    const distM = Number.isFinite(horizontalDistM) ? horizontalDistM : 0;
    const dtSafe = Number.isFinite(dt) ? dt : 0;
    const speedMps = (distM > 0 && dtSafe > 1e-4) ? distM / dtSafe : 0;
    updateWaterLoop(inWater ? speedMps : 0, dtSafe);

    if (distM <= 0) {
        footLastInWater = !!inWater;
        return;
    }
    if (inWater) {
        footAccumDistM = 0;
        if (!footLastInWater) {
            playWaterEntrySplash(clamp(speedMps / 3.6, 0.85, 1.2));
        }
        footLastInWater = true;
        return;
    }
    let stepDistanceM = STEP_DISTANCE_M;
    if (dtSafe > 1e-4) {
        stepDistanceM = Math.max(STEP_DISTANCE_M, speedMps * STEP_INTERVAL_MIN_S);
    }
    footAccumDistM += distM;
    while (footAccumDistM >= stepDistanceM) {
        footAccumDistM -= stepDistanceM;
        playFootstep();
    }
    footLastInWater = !!inWater;
}

// Heavy landing thud. Volume + low-end weight scale with impact velocity:
// stepping off a 30 cm kerb is a soft tap; falling 50 m is a substantial
// thump. Reuses the footstep AudioContext + noise buffer.
const THUD_MIN_SPEED_MPS = 1.5;     // below this, no audible thud
const THUD_FULL_SPEED_MPS = 11;     // saturate volume at terminal velocity
const THUD_MAX_GAIN = 0.45;
export function playLandingThud(impactSpeedMps) {
    if (!footRunning || !footCtx) return;
    const speed = Number.isFinite(impactSpeedMps) ? impactSpeedMps : 0;
    if (speed < THUD_MIN_SPEED_MPS) return;
    const k = Math.min(1, (speed - THUD_MIN_SPEED_MPS) / (THUD_FULL_SPEED_MPS - THUD_MIN_SPEED_MPS));
    const gain = THUD_MAX_GAIN * (0.4 + 0.6 * k);
    const decayS = 0.18 + 0.20 * k;       // softer hits decay faster
    const t = footCtx.currentTime;

    // Low body: 90 → 35 Hz sine, fast attack, longer decay than a footstep.
    const body = footCtx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(90, t);
    body.frequency.exponentialRampToValueAtTime(35, t + decayS * 0.7);
    const bodyGain = footCtx.createGain();
    bodyGain.gain.setValueAtTime(0, t);
    bodyGain.gain.linearRampToValueAtTime(gain, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + decayS);
    body.connect(bodyGain).connect(getAudioDestination(footCtx));
    body.start(t);
    body.stop(t + decayS + 0.05);

    // Crunch: low-passed noise burst — adds the "stuff hit something" feel.
    const crunch = footCtx.createBufferSource();
    crunch.buffer = footNoiseBuffer;
    const crunchFilter = footCtx.createBiquadFilter();
    crunchFilter.type = 'lowpass';
    crunchFilter.frequency.value = 600;
    const crunchGain = footCtx.createGain();
    crunchGain.gain.setValueAtTime(0, t);
    crunchGain.gain.linearRampToValueAtTime(gain * 0.7, t + 0.004);
    crunchGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    crunch.connect(crunchFilter).connect(crunchGain).connect(getAudioDestination(footCtx));
    crunch.start(t);
    crunch.stop(t + 0.12);
}

export function playLandingImpact(impactSpeedMps, inWater = false) {
    if (inWater) {
        playWaterEntrySplash(splashIntensityFromImpactSpeed(impactSpeedMps));
        return;
    }
    playLandingThud(impactSpeedMps);
}

// ─── Jetpack ───────────────────────────────────────────────────────────────
let jetRunning = false;
let jetSource = null;
let jetGain = null;
let jetCurrentGain = 0;
let jetNoiseBuffer = null;
let jetDesiredActive = false;
let jetUnlockCancel = null;

function initJetpackAudio() {
    if (!jetRunning) return false;
    if (!ensureWalkCtx()) return false;
    resumeUnlockedAudioContext(footCtx);
    if (jetSource && jetGain) return true;

    // 1 s of looped white noise, band-passed to get a thrust-y hiss.
    if (!jetNoiseBuffer) {
        const len = Math.floor(footCtx.sampleRate * 1.0);
        jetNoiseBuffer = footCtx.createBuffer(1, len, footCtx.sampleRate);
        const data = jetNoiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }

    jetSource = footCtx.createBufferSource();
    jetSource.buffer = jetNoiseBuffer;
    jetSource.loop = true;

    const lp = footCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    lp.Q.value = 0.6;
    const hp = footCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;

    jetGain = footCtx.createGain();
    jetGain.gain.value = 0;

    jetSource.connect(hp).connect(lp).connect(jetGain).connect(getAudioDestination(footCtx));
    jetSource.start();
    jetCurrentGain = 0;
    return true;
}

function queueJetpackAudioInit() {
    bindGlobalAudioUnlock();
    if (jetUnlockCancel) return;
    jetUnlockCancel = whenAudioUnlocked(() => {
        jetUnlockCancel = null;
        if (jetDesiredActive) initJetpackAudio();
    });
}

export function startJetpack() {
    if (jetRunning) return;
    jetRunning = true;
    jetDesiredActive = false;
    bindGlobalAudioUnlock();
}

function destroyJetpackNodes() {
    if (jetSource) {
        try { jetSource.stop(); } catch (_) {}
        try { jetSource.disconnect(); } catch (_) {}
        jetSource = null;
    }
    if (jetGain) {
        try { jetGain.disconnect(); } catch (_) {}
        jetGain = null;
    }
    jetCurrentGain = 0;
}

export function stopJetpack() {
    if (jetUnlockCancel) {
        jetUnlockCancel();
        jetUnlockCancel = null;
    }
    destroyJetpackNodes();
    jetRunning = false;
    jetDesiredActive = false;
}

// Smoothly ramp the jetpack gain toward target (active=full, !active=silent).
// Called per frame during walk mode.
export function updateJetpack(active, dt) {
    if (!jetRunning) return;
    jetDesiredActive = !!active;
    if (!jetDesiredActive && (!jetGain || jetCurrentGain <= AUDIO_GAIN_EPSILON)) return;
    if ((!jetGain || !footCtx) && !initJetpackAudio()) {
        if (jetDesiredActive) queueJetpackAudioInit();
        return;
    }
    resumeUnlockedAudioContext(footCtx);
    const target = jetDesiredActive ? JETPACK_MAX_GAIN : 0;
    const delta = target - jetCurrentGain;
    if (Math.abs(delta) <= AUDIO_GAIN_EPSILON) return;
    // Per-frame gain step. JETPACK_FADE_PER_S is "fractions of MAX_GAIN
    // per second", so multiplying by JETPACK_MAX_GAIN converts it into
    // raw gain units. At 6/s and MAX_GAIN=0.10 the ramp from full→silent
    // takes ~170 ms — fast enough to feel snappy on Space release.
    const maxStep = JETPACK_FADE_PER_S * Math.max(0, Number(dt) || 0) * JETPACK_MAX_GAIN;
    if (Math.abs(delta) <= maxStep) {
        jetCurrentGain = target;
    } else {
        jetCurrentGain += (delta > 0 ? 1 : -1) * maxStep;
    }
    // setValueAtTime (not setTargetAtTime) so the gain hits exactly 0 with
    // no exponential tail when the jetpack is released.
    jetGain.gain.setValueAtTime(jetCurrentGain, footCtx.currentTime);
    if (!jetDesiredActive && jetCurrentGain <= AUDIO_GAIN_EPSILON) {
        destroyJetpackNodes();
    }
}

// ─── Combined start/stop convenience ──────────────────────────────────────
export function startWalkAudio() {
    startFootsteps();
    startJetpack();
}
export function stopWalkAudio() {
    stopFootsteps();
    stopJetpack();
}
