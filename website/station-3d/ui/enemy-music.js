// Positional enemy loudspeaker music for hostile cars and trams. A small fixed
// set of channels follows the nearest active speaker for each track so the
// battlefield sounds busy without creating an audio node per enemy.

import * as THREE from 'three';
import { camera } from '../scene/setup.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

const TRACKS = [
    { id: 'bella-ciao', url: station3dAssetUrl('audio/enemy-music/bella-ciao.mp3') },
    { id: 'soviet-anthem', url: station3dAssetUrl('audio/enemy-music/soviet-anthem.mp3') },
    { id: 'internationale', url: station3dAssetUrl('audio/enemy-music/internationale.mp3') },
];

const AUDIBLE_RADIUS_M = 260;
const FULL_VOLUME_RADIUS_M = 22;
const BASE_GAIN = 0.18;
const GAIN_SMOOTH_S = 0.16;
const PAN_RADIUS_M = 60;
const AUDIO_UPDATE_INTERVAL_S = 1 / 20;
const CHANNEL_IDLE_STOP_S = 1;
const GAIN_TARGET_EPSILON = 0.0001;
const PAN_TARGET_EPSILON = 0.002;

let audioCtx = null;
let masterGain = null;
let buffers = null;
let bufferPromise = null;
let warnedLoadFailure = false;
let unlockCancel = null;
let updateAccumS = AUDIO_UPDATE_INTERVAL_S;

const frameSpeakers = [];
const channels = TRACKS.map(() => null);
const _cameraRight = new THREE.Vector3();
const _speakerDelta = new THREE.Vector3();

function ensureEnemyMusicAudio() {
    if (audioCtx) return audioCtx;
    try {
        audioCtx = createUnlockedAudioContext();
        if (!audioCtx) return null;
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.75;
        masterGain.connect(getAudioDestination(audioCtx));
    } catch (_) {
        audioCtx = null;
        masterGain = null;
    }
    return audioCtx;
}

function queueEnemyMusicWarmup() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        const ctx = ensureEnemyMusicAudio();
        if (!ctx) return;
        resumeUnlockedAudioContext(ctx);
        ensureTrackBuffers();
    });
}

async function ensureTrackBuffers() {
    const ctx = ensureEnemyMusicAudio();
    if (!ctx) return null;
    if (buffers) return buffers;
    if (bufferPromise) return bufferPromise;

    bufferPromise = Promise.all(TRACKS.map(async (track) => {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error(`Failed to load ${track.url}: ${res.status}`);
        const data = await res.arrayBuffer();
        return ctx.decodeAudioData(data);
    })).then((loaded) => {
        buffers = loaded;
        return loaded;
    }).catch((err) => {
        bufferPromise = null;
        if (!warnedLoadFailure) {
            warnedLoadFailure = true;
            console.warn('[enemy-music] Could not load enemy music clips', err);
        }
        return null;
    });
    return bufferPromise;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function gainForDistance(distM, power) {
    if (distM >= AUDIBLE_RADIUS_M) return 0;
    const falloff = 1 - clamp01((distM - FULL_VOLUME_RADIUS_M) /
        (AUDIBLE_RADIUS_M - FULL_VOLUME_RADIUS_M));
    return BASE_GAIN * power * falloff * falloff;
}

function ensureChannel(trackIndex) {
    const ctx = ensureEnemyMusicAudio();
    if (!ctx || !buffers || !buffers[trackIndex]) return null;
    if (channels[trackIndex]) return channels[trackIndex];

    const source = ctx.createBufferSource();
    source.buffer = buffers[trackIndex];
    source.loop = true;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 260;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2450;
    lowpass.Q.value = 0.75;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    source.connect(highpass).connect(lowpass).connect(gain).connect(panner).connect(masterGain);
    source.start(ctx.currentTime, Math.random() * Math.max(0.1, source.buffer.duration - 0.1));

    channels[trackIndex] = {
        source,
        highpass,
        lowpass,
        gain,
        panner,
        targetGain: 0,
        targetPan: 0,
        idleSinceS: null,
    };
    return channels[trackIndex];
}

function setChannelTarget(channel, targetGain, pan) {
    const ctx = ensureEnemyMusicAudio();
    if (!ctx || !channel) return;
    if (Math.abs(targetGain - channel.targetGain) >= GAIN_TARGET_EPSILON) {
        channel.targetGain = targetGain;
        channel.gain.gain.setTargetAtTime(targetGain, ctx.currentTime, GAIN_SMOOTH_S);
    }
    if (Math.abs(pan - channel.targetPan) >= PAN_TARGET_EPSILON) {
        channel.targetPan = pan;
        channel.panner.pan.setTargetAtTime(pan, ctx.currentTime, 0.06);
    }
}

function stopChannel(trackIndex) {
    const channel = channels[trackIndex];
    if (!channel) return;
    try { channel.source.stop(); } catch (_) {}
    for (const node of [
        channel.source,
        channel.highpass,
        channel.lowpass,
        channel.gain,
        channel.panner,
    ]) {
        try { node?.disconnect(); } catch (_) {}
    }
    channels[trackIndex] = null;
}

function nearestSpeakerForTrack(trackIndex) {
    let best = null;
    let bestD2 = Infinity;
    for (const sp of frameSpeakers) {
        if (sp.trackIndex !== trackIndex) continue;
        if (sp.d2 < bestD2) {
            bestD2 = sp.d2;
            best = sp;
        }
    }
    return best;
}

export function bindEnemyMusicUnlock() {
    bindGlobalAudioUnlock();
    const ctx = ensureEnemyMusicAudio();
    if (!ctx) {
        queueEnemyMusicWarmup();
        return;
    }
    resumeUnlockedAudioContext(ctx);
    ensureTrackBuffers();
}

export function getEnemyMusicTrackCount() {
    return TRACKS.length;
}

export function resetEnemyMusicFrame() {
    frameSpeakers.length = 0;
}

export function queueEnemyMusicSpeaker(x, y, z, power = 1, trackIndex = 0) {
    if (!camera) return;
    const dx = x - camera.position.x;
    const dy = y - camera.position.y;
    const dz = z - camera.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const audible2 = AUDIBLE_RADIUS_M * AUDIBLE_RADIUS_M;
    if (d2 > audible2) return;
    frameSpeakers.push({
        x,
        y,
        z,
        d2,
        power,
        trackIndex: Math.abs(Math.floor(trackIndex)) % TRACKS.length,
    });
}

export function tickEnemyMusic(dt) {
    bindGlobalAudioUnlock();
    updateAccumS += Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (updateAccumS < AUDIO_UPDATE_INTERVAL_S) {
        frameSpeakers.length = 0;
        return;
    }
    updateAccumS %= AUDIO_UPDATE_INTERVAL_S;

    const ctx = ensureEnemyMusicAudio();
    if (!ctx || !masterGain || !camera) {
        frameSpeakers.length = 0;
        return;
    }
    resumeUnlockedAudioContext(ctx);
    if (!buffers) {
        ensureTrackBuffers();
        frameSpeakers.length = 0;
        return;
    }

    if (frameSpeakers.length > 0) {
        camera.updateMatrixWorld();
        _cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    }

    for (let i = 0; i < TRACKS.length; i++) {
        const sp = nearestSpeakerForTrack(i);
        let ch = channels[i];
        if (!sp) {
            if (!ch) continue;
            setChannelTarget(ch, 0, 0);
            if (ch.idleSinceS == null) ch.idleSinceS = ctx.currentTime;
            if (ctx.currentTime - ch.idleSinceS >= CHANNEL_IDLE_STOP_S) {
                stopChannel(i);
            }
            continue;
        }
        ch = ensureChannel(i);
        if (!ch) continue;
        ch.idleSinceS = null;
        const distM = Math.sqrt(sp.d2);
        _speakerDelta.set(sp.x - camera.position.x, sp.y - camera.position.y, sp.z - camera.position.z);
        const pan = Math.max(-0.85, Math.min(0.85, _speakerDelta.dot(_cameraRight) / PAN_RADIUS_M));
        setChannelTarget(ch, gainForDistance(distM, sp.power), pan);
    }

    frameSpeakers.length = 0;
}

export function stopEnemyMusic() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    frameSpeakers.length = 0;
    for (let i = 0; i < channels.length; i++) {
        stopChannel(i);
    }
    updateAccumS = AUDIO_UPDATE_INTERVAL_S;
}
