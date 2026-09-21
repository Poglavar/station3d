// Station PA (public address) for the cab. Two cues:
//   1. ARRIVAL: when the tram pulls into a stop, just the station name plays
//      ("Trg bana Josipa Jelačića").
//   2. APPROACH: a few seconds after departing the previous stop, the full
//      bilingual announcement plays ("Sljedeća postaja je... The next stop
//      is... <next station name>"). Prefix + name are scheduled back-to-back
//      via Web Audio so the seam is tight.
//
// Files come from audio/announcements/{prefix.mp3, <slug>.mp3}, indexed by
// audio/announcements/manifest.json. Name buffers decode lazily on first
// use; a small LRU keeps them around so a line that revisits a stop doesn't
// re-fetch.

import {
    bindGlobalAudioUnlock,
    createUnlockedAudioContext,
    getAudioDestination,
    hasAudioUnlock,
    resumeUnlockedAudioContext,
    whenAudioUnlocked,
} from '../core/audio-unlock.js';

const MANIFEST_URL = 'station-3d/audio/announcements/manifest.json';
const ASSET_BASE   = 'station-3d/';

// Delay between leaving a stop and firing the approach announcement.
const APPROACH_DELAY_S = 4.0;

// Per-clip gain. PA voice should sit clearly above ambient + engine whine
// without dominating; 0.85 reads as authoritative.
const PA_GAIN = 0.85;

let ctx = null;
let manifest = null;
let manifestLoading = null;
const bufferCache = new Map();    // file URL → AudioBuffer (or pending Promise)
let prefixBuffer = null;
let prefixLoading = null;

// Per-cab-session state. Reset on start.
let lastPausedStationName = null;     // station we last detected as PAUSED at
let pendingApproachName = null;       // name to announce
let pendingApproachAtS = 0;           // performance.now()/1000 when to fire
let lastApproachAnnouncedFor = null;  // dedupe — don't double-fire for same target
let activeSources = [];               // currently scheduled BufferSourceNodes (for stop)
let unlockCancel = null;

function nowS() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

function ensureCtx() {
    if (ctx) return ctx;
    ctx = createUnlockedAudioContext();
    return ctx;
}

function warmStationPaAudio() {
    const c = ensureCtx();
    if (!c) return false;
    resumeUnlockedAudioContext(c);
    loadManifest().then(() => getPrefixBuffer());
    return true;
}

function queueStationPaWarmup() {
    bindGlobalAudioUnlock();
    if (unlockCancel) return;
    unlockCancel = whenAudioUnlocked(() => {
        unlockCancel = null;
        warmStationPaAudio();
    });
}

async function loadManifest() {
    if (manifest) return manifest;
    if (manifestLoading) return manifestLoading;
    manifestLoading = fetch(MANIFEST_URL, { cache: 'no-cache' })
        .then(r => {
            if (!r.ok) throw new Error(`manifest fetch ${r.status}`);
            return r.json();
        })
        .then(j => { manifest = j; return j; })
        .catch(err => {
            console.warn('[station-pa] manifest load failed:', err.message);
            manifest = { stations: {} };
            return manifest;
        });
    return manifestLoading;
}

async function getPrefixBuffer() {
    if (prefixBuffer) return prefixBuffer;
    if (prefixLoading) return prefixLoading;
    const m = await loadManifest();
    const c = ensureCtx();
    if (!c || !m || !m.prefix) return null;
    prefixLoading = fetch(ASSET_BASE + m.prefix.file)
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`prefix fetch ${r.status}`)))
        .then(ab => c.decodeAudioData(ab))
        .then(buf => { prefixBuffer = buf; return buf; })
        .catch(err => { console.warn('[station-pa] prefix load failed:', err.message); return null; });
    return prefixLoading;
}

async function getNameBuffer(stationName) {
    const m = await loadManifest();
    const entry = m.stations && m.stations[stationName];
    if (!entry) return null;     // unknown station — skip silently
    const url = ASSET_BASE + entry.file;
    const cached = bufferCache.get(url);
    if (cached && cached.then) return cached;     // pending
    if (cached) return cached;
    const c = ensureCtx();
    if (!c) return null;
    const p = fetch(url)
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`name fetch ${r.status}`)))
        .then(ab => c.decodeAudioData(ab))
        .then(buf => { bufferCache.set(url, buf); return buf; })
        .catch(err => { console.warn('[station-pa] name load failed:', stationName, err.message); bufferCache.delete(url); return null; });
    bufferCache.set(url, p);
    return p;
}

function scheduleBuffer(buf, startAt, gain) {
    const c = ensureCtx();
    if (!c || !buf) return 0;
    resumeUnlockedAudioContext(c);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(getAudioDestination(c));
    src.start(startAt);
    activeSources.push(src);
    src.onended = () => {
        const idx = activeSources.indexOf(src);
        if (idx >= 0) activeSources.splice(idx, 1);
        try { src.disconnect(); g.disconnect(); } catch (_) {}
    };
    return buf.duration;
}

async function playApproach(stationName) {
    const c = ensureCtx();
    if (!c) return;
    const [prefix, name] = await Promise.all([
        getPrefixBuffer(),
        getNameBuffer(stationName),
    ]);
    if (!prefix || !name) return;
    const startAt = c.currentTime + 0.02;     // tiny lead-in to avoid scheduling-in-the-past glitches
    const prefixDur = scheduleBuffer(prefix, startAt, PA_GAIN);
    // Slight 60 ms gap between prefix-end and name-start so the seam reads
    // as a deliberate pause rather than a click. Real ZET tape splices
    // have a similar hair of silence.
    scheduleBuffer(name, startAt + prefixDur + 0.06, PA_GAIN);
}

async function playArrival(stationName) {
    const c = ensureCtx();
    if (!c) return;
    const name = await getNameBuffer(stationName);
    if (!name) return;
    const startAt = c.currentTime + 0.02;
    scheduleBuffer(name, startAt, PA_GAIN);
}

export function preloadStationPa() {
    bindGlobalAudioUnlock();
    loadManifest();
    if (!warmStationPaAudio()) queueStationPaWarmup();
    lastPausedStationName = null;
    pendingApproachName = null;
    pendingApproachAtS = 0;
    lastApproachAnnouncedFor = null;
}

export function bindAudioUnlock() {
    bindGlobalAudioUnlock();
    queueStationPaWarmup();
}

// Frame hook. status comes from the same poseFn() that drives the cab —
// has .paused, .stationName (when paused), and .nextStation.name (when
// in transit). We watch transitions:
//   - leaving a stop (was paused → not) ⇒ schedule approach in 4s
//   - arriving at a stop (not → paused with new name) ⇒ play arrival now
export function updateStationPa(status) {
    if (!status) return;
    // While audio is still locked no clip can play, and advancing the
    // transition state would burn the dedupe keys — the first leg's
    // "sljedeća postaja" would be marked announced and never heard, even
    // if the player unlocks a second later. Stay frozen until the gate
    // opens, then pick the ride up from wherever it is.
    if (!hasAudioUnlock()) return;
    const tS = nowS();

    // Arrival detection: we just transitioned into paused at a new station.
    if (status.paused && status.stationName) {
        if (status.stationName !== lastPausedStationName) {
            lastPausedStationName = status.stationName;
            playArrival(status.stationName);
            // Cancel any pending approach (the tram arrived before its
            // scheduled approach announcement got to fire).
            pendingApproachName = null;
        }
        return;
    }

    // We're in transit (or driver-mode without a paused flag).
    if (lastPausedStationName != null) {
        // Just departed — schedule approach for the next stop. We use the
        // name we KNOW from status.nextStation; if it isn't there yet
        // (legacy poses), skip and wait for the next frame to expose it.
        const nextName = status.nextStation && status.nextStation.name;
        if (nextName) {
            // Only schedule once per leg — the dedupe key is the target name.
            if (lastApproachAnnouncedFor !== nextName) {
                pendingApproachName = nextName;
                pendingApproachAtS = tS + APPROACH_DELAY_S;
                lastApproachAnnouncedFor = nextName;
            }
            lastPausedStationName = null;
        }
    }

    // Fire the scheduled approach when due.
    if (pendingApproachName && tS >= pendingApproachAtS) {
        const name = pendingApproachName;
        pendingApproachName = null;
        playApproach(name);
    }
}

export function stopStationPa() {
    if (unlockCancel) {
        unlockCancel();
        unlockCancel = null;
    }
    for (const src of activeSources) {
        try { src.stop(); src.disconnect(); } catch (_) {}
    }
    activeSources = [];
    lastPausedStationName = null;
    pendingApproachName = null;
    pendingApproachAtS = 0;
    lastApproachAnnouncedFor = null;
}
