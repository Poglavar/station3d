// Synthesised combat audio shared by enemy cars and enemy trams: distant
// muzzle reports, near-miss bullet whizzes, and metallic hits on the player's tram.

import { camera } from '../scene/setup.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';

const SPEED_OF_SOUND_MPS = 343;
const SHOT_AUDIBLE_M = 360;
const WHIZ_RADIUS_M = 8;
const WHIZ_COOLDOWN_S = 0.09;
const HIT_COOLDOWN_S = 0.055;

let audioCtx = null;
let lastWhizAt = 0;
let lastHitAt = 0;

function ensureCombatAudio() {
    if (audioCtx) return audioCtx;
    audioCtx = createUnlockedAudioContext();
    return audioCtx;
}

function resumeIfNeeded(ctx) {
    resumeUnlockedAudioContext(ctx);
}

function distToCamera(x, y, z) {
    if (!camera) return 9999;
    const dx = x - camera.position.x;
    const dy = y - camera.position.y;
    const dz = z - camera.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function closestSegmentDistanceToCamera(x0, y0, z0, x1, y1, z1) {
    if (!camera) return Infinity;
    const sx = x1 - x0;
    const sy = y1 - y0;
    const sz = z1 - z0;
    const len2 = sx * sx + sy * sy + sz * sz;
    const t = len2 > 0
        ? Math.max(0, Math.min(1, (
            (camera.position.x - x0) * sx +
            (camera.position.y - y0) * sy +
            (camera.position.z - z0) * sz
        ) / len2))
        : 0;
    const px = x0 + sx * t;
    const py = y0 + sy * t;
    const pz = z0 + sz * t;
    return distToCamera(px, py, pz);
}

function makeNoiseBuffer(ctx, dur, decayS) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * decayS));
        data[i] = (Math.random() * 2 - 1) * env;
    }
    return buf;
}

export function playEnemyShotSound(x, y, z, opts = {}) {
    const ctx = ensureCombatAudio();
    if (!ctx) return;
    resumeIfNeeded(ctx);

    const dist = distToCamera(x, y, z);
    if (dist > SHOT_AUDIBLE_M) return;

    const heavy = opts.heavy === true;
    const attenuation = Math.max(0, 1 - dist / SHOT_AUDIBLE_M);
    const delay = Math.min(0.28, dist / SPEED_OF_SOUND_MPS);
    const t = ctx.currentTime + delay;

    const crack = ctx.createBufferSource();
    crack.buffer = makeNoiseBuffer(ctx, heavy ? 0.075 : 0.050, heavy ? 0.018 : 0.012);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = heavy ? 900 : 1350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = heavy
        ? 2400 - attenuation * 800
        : 3200 - attenuation * 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime((heavy ? 0.44 : 0.32) * attenuation, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.09 : 0.06));
    crack.connect(hp).connect(lp).connect(gain).connect(getAudioDestination(ctx));
    crack.start(t);

    const body = ctx.createOscillator();
    body.type = heavy ? 'square' : 'triangle';
    body.frequency.setValueAtTime(heavy ? 125 : 170, t);
    body.frequency.exponentialRampToValueAtTime(heavy ? 58 : 95, t + 0.07);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime((heavy ? 0.18 : 0.10) * attenuation, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    body.connect(bodyGain).connect(getAudioDestination(ctx));
    body.start(t);
    body.stop(t + 0.11);
}

export function playBulletWhizForSegment(x0, y0, z0, x1, y1, z1) {
    const closest = closestSegmentDistanceToCamera(x0, y0, z0, x1, y1, z1);
    if (closest > WHIZ_RADIUS_M) return false;

    const ctx = ensureCombatAudio();
    if (!ctx) return true;
    resumeIfNeeded(ctx);
    const now = ctx.currentTime;
    if (now - lastWhizAt < WHIZ_COOLDOWN_S) return true;
    lastWhizAt = now;

    const closeness = Math.max(0, 1 - closest / WHIZ_RADIUS_M);
    const t = now;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const startFreq = 1500 + Math.random() * 900;
    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.exponentialRampToValueAtTime(420 + Math.random() * 220, t + 0.10);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05 + 0.33 * closeness, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 5.5;
    filter.frequency.value = 1800;

    osc.connect(filter).connect(gain).connect(getAudioDestination(ctx));
    osc.start(t);
    osc.stop(t + 0.13);
    return true;
}

export function playPlayerBulletHitSound(x, y, z, opts = {}) {
    const ctx = ensureCombatAudio();
    if (!ctx) return;
    resumeIfNeeded(ctx);

    const now = ctx.currentTime;
    if (now - lastHitAt < HIT_COOLDOWN_S) return;
    lastHitAt = now;

    const dist = distToCamera(x, y, z);
    const attenuation = Math.max(0.25, 1 - dist / 80);
    const heavy = opts.heavy === true;

    const clang = ctx.createBufferSource();
    clang.buffer = makeNoiseBuffer(ctx, 0.09, 0.018);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 8.0;
    bp.frequency.value = heavy ? 900 : 1250;
    const clangGain = ctx.createGain();
    clangGain.gain.setValueAtTime((heavy ? 0.42 : 0.34) * attenuation, now);
    clangGain.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
    clang.connect(bp).connect(clangGain).connect(getAudioDestination(ctx));
    clang.start(now);

    const ring = ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(heavy ? 320 : 470, now);
    ring.frequency.exponentialRampToValueAtTime(heavy ? 210 : 290, now + 0.20);
    const ringGain = ctx.createGain();
    ringGain.gain.setValueAtTime((heavy ? 0.16 : 0.12) * attenuation, now);
    ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    ring.connect(ringGain).connect(getAudioDestination(ctx));
    ring.start(now);
    ring.stop(now + 0.24);
}
