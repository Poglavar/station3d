// Plays the short non-blocking chime used to punctuate campaign chapter
// changes, routed through Station3D's shared persisted mute boundary.

import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';

const CHIME_NOTES = Object.freeze([
    Object.freeze({ delayS: 0, frequencyHz: 392.00, durationS: 0.46, gain: 0.085 }),
    Object.freeze({ delayS: 0.11, frequencyHz: 523.25, durationS: 0.58, gain: 0.075 }),
    Object.freeze({ delayS: 0.25, frequencyHz: 659.25, durationS: 0.72, gain: 0.065 }),
]);

let audioContext = null;

export function scheduleCampaignChapterChime(ctx, destination, startTime = ctx?.currentTime || 0) {
    if (!ctx || !destination) return 0;
    for (const note of CHIME_NOTES) {
        const beginsAt = startTime + note.delayS;
        const endsAt = beginsAt + note.durationS;
        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.frequencyHz, beginsAt);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, beginsAt);
        gain.gain.exponentialRampToValueAtTime(note.gain, beginsAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
        oscillator.connect(gain).connect(destination);
        oscillator.start(beginsAt);
        oscillator.stop(endsAt + 0.02);
    }
    return CHIME_NOTES.length;
}

export function playCampaignChapterTransitionSound() {
    if (!audioContext) audioContext = createUnlockedAudioContext();
    if (!audioContext) return false;
    resumeUnlockedAudioContext(audioContext);
    return scheduleCampaignChapterChime(
        audioContext,
        getAudioDestination(audioContext),
        audioContext.currentTime,
    ) > 0;
}
