// Extends an authored shot only when its readout needs longer. The same held
// film time is used for camera, captions, curtains and world effects.
import { cinematicReadoutHoldTime } from './campaign-cinematics.js';

const VOICE_TAIL_MS = 350;
const localText = (value, language) => String(value && typeof value === 'object'
    ? value[language] ?? value.hr ?? value.en ?? ''
    : value ?? '').trim();

// Matches the campaign's existing character-based speaking estimate, without
// its lip-animation cap: a long paragraph must get its full reading time.
export function cinematicReadingDurationMs(text) {
    const length = String(text || '').trim().length;
    return length ? Math.max(2200, length / 14 * 1000 + 700) : 0;
}

export function createCinematicReadoutClock(track, { language = 'hr', reducedMotion = false } = {}) {
    const durationMs = Math.max(0, Number(track.durationMs) || 0);
    const cues = (track.captions || []).map((caption, index) => ({
        id: `caption:${index}`, content: caption,
        startMs: Math.max(0, Number(caption.startMs) || 0),
        endMs: Math.min(durationMs, Number(caption.endMs ?? durationMs)),
        text: localText(caption.text, language),
    })).filter(cue => cue.text).sort((a, b) => a.startMs - b.startMs);
    for (const cue of cues) {
        const nextStart = cues.find(other => other.startMs > cue.startMs)?.startMs ?? durationMs;
        const endMs = Math.min(cue.endMs, nextStart);
        cue.holdMs = cinematicReadoutHoldTime(track, cue.startMs, endMs, { reducedMotion });
        cue.minimumMs = cinematicReadingDurationMs(cue.text);
    }
    let elapsedMs = 0;
    let readout = null;
    const updateCue = () => {
        const cue = cues.find(item => elapsedMs >= item.startMs && elapsedMs < item.endMs) || null;
        if (readout?.cue === cue) return;
        readout = cue ? { cue, shownMs: 0, narration: 'none', tailMs: 0 } : null;
    };
    const waiting = () => readout && (readout.narration === 'playing'
        || (readout.narration === 'complete' ? readout.tailMs < VOICE_TAIL_MS : readout.shownMs < readout.cue.minimumMs));
    updateCue();
    return {
        get elapsedMs() { return elapsedMs; },
        get cue() { return readout?.cue || null; },
        get holding() { return !!waiting() && elapsedMs >= readout.cue.holdMs; },
        advance(deltaMs) {
            const step = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
            if (readout) {
                readout.shownMs += step;
                if (readout.narration === 'complete') readout.tailMs += step;
            }
            let nextMs = Math.min(durationMs, elapsedMs + step);
            if (waiting()) nextMs = Math.min(nextMs, Math.max(elapsedMs, readout.cue.holdMs));
            // Even a long frame must publish a new cue before going past it,
            // so its audio can start before the next advancement decision.
            const nextCue = cues.find(cue => cue.startMs > elapsedMs && cue.startMs <= nextMs);
            if (nextCue) nextMs = nextCue.startMs;
            elapsedMs = nextMs;
            updateCue();
            return elapsedMs;
        },
        beginNarration(cueId) {
            if (readout?.cue.id !== cueId) return false;
            readout.narration = 'playing';
            return true;
        },
        endNarration(cueId, { completed = true } = {}) {
            if (readout?.cue.id !== cueId || readout.narration !== 'playing') return false;
            readout.narration = completed ? 'complete' : 'none';
            readout.tailMs = 0;
            return true;
        },
    };
}
