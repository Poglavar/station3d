// Resolves declarative campaign voice profiles to browser speech-synthesis
// settings without coupling campaign content to platform-specific voice lists.
// The language decides first: a Croatian line gets a Croatian voice or none
// at all (the browser then picks by utterance.lang), never an English voice
// that happens to have a friendly name.

const YOUNG_WOMAN_VOICE_NAMES = Object.freeze([
    'lana',
    'serena',
    'samantha',
    'ava',
    'zoe',
    'victoria',
    'karen',
    'moira',
    'tessa',
    'fiona',
    'hazel',
    'susan',
    'zira',
    'female',
    'žena',
    'zena',
]);

const MAN_VOICE_NAMES = Object.freeze([
    'matej',
    'daniel',
    'alex',
    'fred',
    'tom',
    'oliver',
    'george',
    'arthur',
    'david',
    'male',
    'muški',
    'muski',
]);

const PROFILES = Object.freeze({
    'young-woman': Object.freeze({ names: YOUNG_WOMAN_VOICE_NAMES, rate: 0.98, pitch: 1.06 }),
    'middle-aged-man': Object.freeze({ names: MAN_VOICE_NAMES, rate: 0.92, pitch: 0.92 }),
    'old-man': Object.freeze({ names: MAN_VOICE_NAMES, rate: 0.88, pitch: 0.86 }),
    'old-woman': Object.freeze({ names: YOUNG_WOMAN_VOICE_NAMES, rate: 0.9, pitch: 0.98 }),
});

function normalized(value) {
    return String(value || '').trim().toLowerCase();
}

function languageTag(language) {
    return normalized(language).startsWith('hr') ? 'hr-HR' : 'en-GB';
}

// 'hr-HR', 'hr_HR' and 'hr' all belong to the same language.
function voiceLanguage(voice) {
    return normalized(voice?.lang).replace('_', '-').split('-')[0];
}

function nameMatches(voice, names) {
    const name = normalized(voice?.name);
    return (names || []).some(candidate => name.includes(candidate));
}

// Voices of the requested language only, best first: a name matching the
// profile, then local (offline) voices, then premium/enhanced builds.
export function preferredVoice(voices, lang, profile) {
    const language = normalized(lang).split('-')[0];
    const names = PROFILES[normalized(profile)]?.names || [];
    const candidates = [...(voices || [])].filter(voice => voiceLanguage(voice) === language);
    if (candidates.length === 0) return null;
    const score = voice => (nameMatches(voice, names) ? 4 : 0)
        + (voice?.localService === true ? 2 : 0)
        + (/premium|enhanced|natural|neural/.test(normalized(voice?.name)) ? 1 : 0);
    return candidates.sort((left, right) => score(right) - score(left))[0];
}

export function campaignSpeechPlan({ profile = '', language = 'en', voices = [] } = {}) {
    const lang = languageTag(language);
    const normalizedProfile = normalized(profile);
    const settings = PROFILES[normalizedProfile];
    return {
        lang,
        rate: settings?.rate ?? 0.94,
        pitch: settings?.pitch ?? 1,
        voice: preferredVoice(voices, lang, normalizedProfile),
    };
}
