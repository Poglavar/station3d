// Sparse two-person street conversations, generic unless a cityId is set.
// Audio is generated ahead of time; this is the authoritative script/speaker
// mapping shared by the generator, runtime, tests and the voice editor's Ulica
// tab, which edits the text here. A Croatian line recorded with ElevenLabs in that editor plays
// instead of its generated clip while the take still says the current words.

import { textHash } from './campaign-voice-lines.js';

export const CONVERSATION_LANGUAGES = Object.freeze(['hr', 'en']);

export const PEDESTRIAN_CONVERSATIONS = Object.freeze([
    {
        cityId: 'zagreb',
        id: 'c1',
        lines: [
            ['A', 'Jesi gledal Dinamo jučer?', 'Did you watch Dinamo yesterday?'],
            ['B', 'Jesam, a kaj da ti velim?', 'I did. What can I say?'],
            ['A', 'Ak buju tak igrali i u sljedećoj, mogu proć dalje.', 'If they play like that next time, they could go through.'],
            ['B', 'Nije ni ova Barcelona kaj je nekad bila.', "Barcelona aren't what they used to be either."],
        ],
    },
    {
        id: 'c2',
        lines: [
            ['A', 'Nemre to sam tak.', "You can't just do that."],
            ['B', 'Istina.', 'True.'],
            ['A', 'Misle da more to tek tak, e pa nemre.', "They think they can just do it. Well, they can't."],
            ['B', 'Je, ima ih baš dost kaj misle da more.', 'Yeah, plenty of people think they can.'],
            ['A', 'A nemre.', "But they can't."],
            ['B', 'Nemre pa nemre.', "They can't. They just can't."],
        ],
    },
    {
        id: 'c3',
        lines: [
            ['A', 'Cijene kvadrata su fakat otišle nebu pod oblake.', 'Property prices have really gone through the roof.'],
            ['B', 'Istina, ko si to uopće može priuštit?', 'True. Who can even afford it?'],
            ['A', 'Lopovi, eto ko.', "Crooks, that's who."],
            ['B', 'Tako je, treba više poreza...', 'Exactly. We need more taxes...'],
        ],
    },
    {
        id: 'c4',
        lines: [
            ['A', 'Kažu da će umjetna inteligencija zamijeniti ljude. Vjeruješ li u to?', 'They say AI will replace humans. Do you believe it?'],
            ['B', 'Nadam se da će početi od mog muža. Taj nije ni za što.', "I hope they start with my husband. He's good for nothing."],
        ],
    },
    {
        id: 'c5',
        lines: [
            ['A', 'Vrijeme je sjajno ovih dana.', "The weather's been great lately."],
            ['B', 'Baš.', 'It really has.'],
        ],
    },
    {
        cityId: 'zagreb',
        id: 'c6',
        lines: [
            ['A', 'Sutra je finale Lige prvaka, Dinamo protiv Manchester Cityja. Hoćemo gledat?', "Tomorrow's the Champions League final, Dinamo against Man City. Shall we watch?"],
            ['B', 'O da.', 'Oh yes.'],
        ],
    },
    {
        cityId: 'split',
        id: 'c7',
        lines: [
            ['A', 'Lipi moj, ima li ća ribe', 'My friend, are there any fish?'],
            ['B', 'Ima kako ne, ulovija san morskog pasa', 'Of course there are. I caught a shark.'],
        ],
    },
    {
        cityId: 'split',
        id: 'c8',
        lines: [
            ['A', 'Esi li gleda Ajduka sinoć', 'Did you watch Hajduk last night?'],
            ['B', 'Ma jok, ja ti gledan samo zensku odbojku', "No, I only watch women's volleyball."],
        ],
    },
    {
        cityId: 'split',
        id: 'c9',
        lines: [
            ['A', 'Opet neka juzina, a?', 'Another southerly wind, eh?'],
            ['B', 'Je brale, udrilo puvat', 'Yeah, brother, it really started blowing.'],
        ],
    },
].map(script => Object.freeze({
    ...script,
    lines: Object.freeze(script.lines.map(([speaker, hr, en], index) => Object.freeze({
        id: `street.${script.id}.${index + 1}`,
        speaker,
        text: Object.freeze({ hr, en }),
        files: Object.freeze({
            hr: `station-3d/audio/conversations/${script.id}/${index + 1}.mp3`,
            en: `station-3d/audio/conversations/en/${script.id}/${index + 1}.mp3`,
        }),
    }))),
})));

// Keep the complete catalogue above for voice editing/generation. Runtime
// selection combines generic chatter with the current city's local scripts;
// an unknown city gets only generic chatter.
export function pedestrianConversationsForCity(cityId, scripts = PEDESTRIAN_CONVERSATIONS) {
    return scripts.filter(script => script.cityId == null || script.cityId === cityId);
}

export function pedestrianConversationCity(location) {
    // A nearest-city style can also cover distant countryside. Local speech
    // belongs only inside that city's bounds, just like local birds/services.
    if (location?.styleFrom === 'nearest-city') {
        return location.styleCityContainsPosition ? location.styleCityId : null;
    }
    return location?.id || null;
}

export const STREET_VOICE_MANIFEST_URL = 'station-3d/audio/conversations/voice/manifest.json';
const STREET_VOICE_CLIP_BASE = 'station-3d/audio/conversations/voice/';
let recordedClips = new Map();

// The editor's voice manifest: which lines have an ElevenLabs take, and the
// words each take says.
export function setPedestrianConversationClips(manifest) {
    recordedClips = new Map(Object.entries(manifest?.clips || {})
        .filter(([, clip]) => clip?.file && clip?.hash)
        .map(([id, clip]) => [id, { file: `${STREET_VOICE_CLIP_BASE}${clip.file}`, hash: clip.hash }]));
    return recordedClips.size;
}

export function pedestrianConversationLine(line, language = 'hr') {
    const locale = CONVERSATION_LANGUAGES.includes(language) ? language : 'hr';
    const recorded = locale === 'hr' ? recordedClips.get(line.id) : null;
    const file = recorded && recorded.hash === textHash(line.text.hr) ? recorded.file : line.files[locale];
    return { speaker: line.speaker, text: line.text[locale], file };
}

// Both people must be within ten metres before a conversation can begin.
// Once begun, keep following them until the sound has faded completely.
export const CONVERSATION_START_DISTANCE_M = 10;
export const CONVERSATION_PAIR_SEPARATION_M = 3;
export const CONVERSATION_MAX_DISTANCE_M = 45;
// Street sound stops carrying to a listener this far above (or below) it: a
// pilot at 300 m or a jetpack over the rooftops hears wind, not the pavement.
// Below this the vertical gap simply lengthens the distance the gain uses.
export const STREET_LISTENER_MAX_HEIGHT_M = 20;

export function streetListenerOutOfReach(sourceY, listenerY) {
    if (!Number.isFinite(sourceY) || !Number.isFinite(listenerY)) return false;
    return Math.abs(listenerY - sourceY) > STREET_LISTENER_MAX_HEIGHT_M;
}

export function nextConversationDelayS({ first = false, foundPair = true, randomValue = Math.random() } = {}) {
    const r = Math.max(0, Math.min(1, Number(randomValue) || 0));
    if (first) return 10 + r * 16;
    if (!foundPair) return 5 + r * 8;
    return 32 + r * 46;
}

export function conversationSpatial({
    sourceX,
    sourceZ,
    cameraX,
    cameraZ,
    cameraRightX = 1,
    cameraRightZ = 0,
    sourceY = null,
    cameraY = null,
} = {}) {
    const values = [sourceX, sourceZ, cameraX, cameraZ, cameraRightX, cameraRightZ];
    if (!values.every(Number.isFinite)) return null;
    if (streetListenerOutOfReach(sourceY, cameraY)) return null;
    const dx = sourceX - cameraX;
    const dz = sourceZ - cameraZ;
    const dy = Number.isFinite(sourceY) && Number.isFinite(cameraY) ? sourceY - cameraY : 0;
    const distanceM = Math.hypot(dx, dz, dy);
    if (distanceM > CONVERSATION_MAX_DISTANCE_M) return null;
    const rightLength = Math.hypot(cameraRightX, cameraRightZ) || 1;
    const directionLength = Math.max(1, distanceM);
    return {
        distanceM,
        gain: 0.62 * Math.max(0, 1 - distanceM / CONVERSATION_MAX_DISTANCE_M),
        pan: Math.max(-0.8, Math.min(0.8,
            (dx * cameraRightX + dz * cameraRightZ) / (directionLength * rightLength),
        )),
    };
}
