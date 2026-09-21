// Walks a campaign definition into the flat list of spoken lines that need
// recorded audio: conversation beats and variants, player responses, cinematic captions and
// the shouted ui.toast effects. Pure — no fetch, no filesystem — so the line
// set, its stable ids and its cost can be tested without touching the network.
//
// A line id is stable across regenerations (it names where the line lives, not
// its position in an array); the text hash is what decides whether an already
// recorded clip is still current.

// FNV-1a over the UTF-8 bytes: short, stable across runs, and enough to notice
// an edited line. Not a security hash.
export function textHash(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function localized(value, language) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return String(value[language] ?? value.en ?? '');
}

// The player has no actor record; every line they speak shares one voice.
export const PLAYER_SPEAKER_ID = 'courier';
// Cinematic captions are narration, not a character in the world — unless a
// caption names its speaker ("VIKI: „…“"), in which case that character's
// voice reads it and the name stays a label on screen.
export const NARRATOR_SPEAKER_ID = 'narrator';

function pushLine(lines, line) {
    const text = String(line.text || '').trim();
    if (!text) return;
    lines.push(Object.freeze({
        ...line,
        text,
        hash: textHash(text),
        characters: text.length,
    }));
}

function collectConversations(definition, language, lines) {
    for (const conversation of definition?.conversations || []) {
        for (const beat of conversation.beats || []) {
            // A beat the campaign shows but never speaks — the observation
            // lift's menu is a machine's panel, not a character. Its variants
            // and the answers under it are silent with it, so none of them
            // asks for a recording.
            if (beat.voice?.speech === false) continue;
            pushLine(lines, {
                id: `conversation.${conversation.id}.${beat.id}`,
                kind: 'beat',
                conversationId: conversation.id,
                beatId: beat.id,
                speakerId: beat.speakerId || NARRATOR_SPEAKER_ID,
                mood: beat.mood || 'neutral',
                text: localized(beat.text, language),
            });
            (beat.variants || []).forEach((variant, variantIndex) => {
                pushLine(lines, {
                    id: `conversation.${conversation.id}.${beat.id}.variant.${variantIndex}`,
                    kind: 'variant',
                    conversationId: conversation.id,
                    beatId: beat.id,
                    variantIndex,
                    speakerId: variant.speakerId || beat.speakerId || NARRATOR_SPEAKER_ID,
                    mood: variant.mood || beat.mood || 'neutral',
                    text: localized(variant.text, language),
                });
            });
            for (const response of beat.responses || []) {
                pushLine(lines, {
                    id: `conversation.${conversation.id}.${beat.id}.${response.id}`,
                    kind: 'response',
                    conversationId: conversation.id,
                    beatId: beat.id,
                    responseId: response.id,
                    speakerId: PLAYER_SPEAKER_ID,
                    mood: response.tone || 'neutral',
                    text: localized(response.text, language),
                });
            }
        }
    }
}

function collectCinematics(definition, language, lines) {
    for (const cinematic of definition?.cinematics || []) {
        (cinematic.captions || []).forEach((caption, index) => {
            pushLine(lines, {
                id: `cinematic.${cinematic.id}.${index}`,
                kind: 'caption',
                cinematicId: cinematic.id,
                speakerId: caption.speakerId || NARRATOR_SPEAKER_ID,
                mood: caption.mood || (caption.speakerId ? 'neutral' : 'narration'),
                // A caption is on screen for a fixed window; the generator uses
                // it to warn when a reading cannot fit.
                windowMs: Math.max(0, (caption.endMs ?? 0) - (caption.startMs ?? 0)) || null,
                text: localized(caption.text, language),
            });
        });
    }
}

// Every effect a scene fires from its onEnter block or a transition, named by
// where it lives so a line id survives reordering of unrelated effects.
function sceneEffectSources(scene) {
    return [
        ...(scene.onEnter || []).map((effect, index) => ({ effect, source: `onEnter.${index}` })),
        ...(scene.transitions || []).flatMap(transition => (transition.effects || [])
            .map((effect, index) => ({ effect, source: `${transition.id}.${index}` }))),
    ];
}

// Shouted lines are ui.toast effects that asked for speech. They hang off scene
// transitions and onEnter blocks, so walk every effect the scenes carry.
function collectToasts(definition, language, lines) {
    for (const scene of definition?.scenes || []) {
        for (const { effect, source } of sceneEffectSources(scene)) {
            if (effect?.type !== 'ui.toast' || effect.speech !== true) continue;
            pushLine(lines, {
                id: `toast.${scene.id}.${source}`,
                kind: 'toast',
                sceneId: scene.id,
                speakerId: effect.actorId || NARRATOR_SPEAKER_ID,
                mood: effect.mood || 'neutral',
                durationMs: effect.durationMs ?? null,
                text: localized(effect.message, language),
            });
        }
    }
}

// A ui.captions effect is narration over live play (the parachute instructions
// after the bail-out): it reads like a film caption and is voiced by the
// narrator like one. Until 2026-09-10 it was the one narrated text that never
// had a recording and stayed text on screen.
//
// One authored track is often fired from several transitions (the bail-out
// film's complete and skip paths). It is one line, named by the first place
// it fires from, so the script index and the manifest agree on its id.
function collectGameplayCaptions(definition, language, lines) {
    const seen = new Set();
    for (const scene of definition?.scenes || []) {
        for (const { effect, source } of sceneEffectSources(scene)) {
            if (effect?.type !== 'ui.captions') continue;
            (effect.captions || []).forEach((caption, index) => {
                if (seen.has(caption)) return;
                seen.add(caption);
                pushLine(lines, {
                    id: `captions.${scene.id}.${source}.${index}`,
                    kind: 'caption',
                    sceneId: scene.id,
                    speakerId: caption.speakerId || NARRATOR_SPEAKER_ID,
                    mood: caption.mood || (caption.speakerId ? 'neutral' : 'narration'),
                    windowMs: Math.max(0, (caption.endMs ?? 0) - (caption.startMs ?? 0)) || null,
                    text: localized(caption.text, language),
                });
            });
        }
    }
}

// Every spoken line in the campaign, in a stable order, deduplicated by id.
export function campaignVoiceLines(definition, { language = 'hr' } = {}) {
    const lines = [];
    collectConversations(definition, language, lines);
    collectCinematics(definition, language, lines);
    collectToasts(definition, language, lines);
    collectGameplayCaptions(definition, language, lines);
    const byId = new Map();
    for (const line of lines) {
        if (!byId.has(line.id)) byId.set(line.id, line);
    }
    return [...byId.values()];
}

// Identical text spoken by the same voice only needs recording once.
export function voiceLineJobs(lines, speakerVoiceId = () => null) {
    const jobs = new Map();
    for (const line of lines) {
        const voiceId = speakerVoiceId(line.speakerId) || line.speakerId;
        const key = `${voiceId}:${line.hash}`;
        if (!jobs.has(key)) jobs.set(key, { key, voiceId, line, lineIds: [] });
        jobs.get(key).lineIds.push(line.id);
    }
    return [...jobs.values()];
}

// Stable across key order, so a stored signature can be compared literally.
export function settingsSignature(settings) {
    return JSON.stringify(Object.keys(settings || {}).sort().map(key => [key, settings[key]]));
}

// Whether an already recorded clip still represents what we would record now.
// EVERYTHING that shaped the audio has to appear here: the text hash alone is
// not enough, because recasting a character or retuning their delivery changes
// the audio while leaving the text untouched. Missing the voice out of this
// comparison makes a recast look like a no-op and silently keeps the old take.
export function clipIsCurrent(entry, expected) {
    if (!entry || !expected) return false;
    return entry.hash === expected.hash
        && entry.model === expected.model
        && (entry.suffix || '') === (expected.suffix || '')
        && entry.voiceId === expected.voiceId
        && entry.settingsSignature === expected.settingsSignature;
}

export function totalCharacters(lines) {
    return lines.reduce((sum, line) => sum + line.characters, 0);
}

// Speakers in first-appearance order, with how much each has to say.
export function speakerSummary(lines) {
    const speakers = new Map();
    for (const line of lines) {
        if (!speakers.has(line.speakerId)) {
            speakers.set(line.speakerId, { speakerId: line.speakerId, lines: 0, characters: 0 });
        }
        const entry = speakers.get(line.speakerId);
        entry.lines += 1;
        entry.characters += line.characters;
    }
    return [...speakers.values()];
}
