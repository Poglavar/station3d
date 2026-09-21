// Resolves a spoken campaign line to its recorded clip from the generated voice
// manifest, by speaker and the same text hash the generator wrote. A line whose
// text drifted since its recording therefore finds no clip and falls back to
// speech synthesis instead of playing the wrong words; a line in a language
// that was never recorded (the English UI) falls back the same way. Pure: the
// caller fetches the manifest and turns file names into URLs.

import { textHash } from './campaign-voice-lines.js';

export function createVoiceClipIndex(manifest, { urlFor = file => file } = {}) {
    const bySpeakerAndHash = new Map();
    const byHash = new Map();
    for (const [id, entry] of Object.entries(manifest?.clips || {})) {
        if (!entry?.file || !entry?.hash) continue;
        const clip = Object.freeze({
            id,
            file: entry.file,
            url: urlFor(entry.file),
            speakerId: entry.speakerId || null,
            hash: entry.hash,
        });
        const key = `${clip.speakerId}:${clip.hash}`;
        if (!bySpeakerAndHash.has(key)) bySpeakerAndHash.set(key, clip);
        if (!byHash.has(clip.hash)) byHash.set(clip.hash, clip);
    }
    return Object.freeze({
        size: bySpeakerAndHash.size,
        // The speaker's own take when there is one; any speaker's take of the
        // identical text otherwise (the generator records shared text once).
        resolve({ text, speakerId = null } = {}) {
            const spoken = String(text || '').trim();
            if (!spoken) return null;
            const hash = textHash(spoken);
            return bySpeakerAndHash.get(`${speakerId}:${hash}`) || byHash.get(hash) || null;
        },
    });
}
