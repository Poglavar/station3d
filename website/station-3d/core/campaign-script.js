// A pure, editor-facing index of every authored line in a campaign.  The UI
// supplies its translated strings as data; this module deliberately does not
// import i18n, the filesystem, or any rendering code.

import {
    campaignVoiceLines,
    NARRATOR_SPEAKER_ID,
    PLAYER_SPEAKER_ID,
    textHash,
} from './campaign-voice-lines.js';

export const SCRIPT_ENTRY_KINDS = Object.freeze([
    'beat', 'variant', 'response', 'cinematic-caption', 'caption', 'toast',
    'objective', 'target', 'journal', 'title', 'label', 'metadata', 'interface',
]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pathKey = path => JSON.stringify(path);
const clean = value => String(value ?? '').trim();
const localized = value => value && typeof value === 'object'
    && !Array.isArray(value) && (own(value, 'hr') || own(value, 'en'))
    && typeof value.hr !== 'object' && typeof value.en !== 'object';
const textOf = value => ({
    hr: clean(value?.hr ?? value?.en),
    en: clean(value?.en ?? value?.hr),
});
const isIndex = value => Number.isInteger(value);

function walkLocalized(value, path = [], found = new Map(), seen = new Set()) {
    if (!value || typeof value !== 'object') return found;
    if (localized(value)) {
        if (!found.has(value)) found.set(value, []);
        found.get(value).push(path);
        return found;
    }
    // `seen` is an ancestor stack, not a global set: authored constants such
    // as a caption array may deliberately be reused by two effects and both
    // exact paths must remain available to an editor.
    if (seen.has(value)) return found;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        if ((key === 'spec' || key === 'model' || key === 'geometry')
            && path[0] === 'worldEffects') continue;
        walkLocalized(child, [...path, Array.isArray(value) ? Number(key) : key], found, seen);
    }
    seen.delete(value);
    return found;
}

function sceneEffectGroups(scene) {
    return [
        ...(scene.onEnter || []).map((effect, index) => ({ effect, path: ['onEnter', index], trigger: null })),
        ...(scene.transitions || []).flatMap((transition, transitionIndex) => (transition.effects || [])
            .map((effect, effectIndex) => ({
                effect,
                path: ['transitions', transitionIndex, 'effects', effectIndex],
                trigger: transition,
            }))),
        ...(scene.resumeEffects || []).flatMap((resume, resumeIndex) => (resume.effects || [])
            .map((effect, effectIndex) => ({
                effect,
                path: ['resumeEffects', resumeIndex, 'effects', effectIndex],
                trigger: { id: `resume-${resumeIndex}`, event: 'resume', when: resume.when },
            }))),
    ];
}

function voiceSources(definition) {
    const byObject = new Map();
    const add = (source, metadata) => {
        if (localized(source) && !byObject.has(source)) byObject.set(source, metadata);
    };
    for (const conversation of definition?.conversations || []) {
        for (const beat of conversation.beats || []) {
            // Shown but never spoken (the observation lift's panel): no voice
            // source for the beat, its variants or the answers under it, so the
            // script agrees with core/campaign-voice-lines.js about what is spoken.
            if (beat.voice?.speech === false) continue;
            add(beat.text, { id: `conversation.${conversation.id}.${beat.id}`, kind: 'beat',
                speakerId: beat.speakerId || NARRATOR_SPEAKER_ID, mood: beat.mood || 'neutral',
                conversationId: conversation.id, beatId: beat.id });
            (beat.variants || []).forEach((variant, index) => add(variant.text, {
                id: `conversation.${conversation.id}.${beat.id}.variant.${index}`, kind: 'variant',
                speakerId: variant.speakerId || beat.speakerId || NARRATOR_SPEAKER_ID,
                mood: variant.mood || beat.mood || 'neutral', conversationId: conversation.id,
                beatId: beat.id, variantIndex: index, when: variant.when || null,
            }));
            for (const response of beat.responses || []) add(response.text, {
                id: `conversation.${conversation.id}.${beat.id}.${response.id}`, kind: 'response',
                speakerId: PLAYER_SPEAKER_ID, mood: response.tone || 'neutral',
                conversationId: conversation.id, beatId: beat.id, responseId: response.id,
                tone: response.tone || null, rememberAs: response.rememberAs || null,
            });
        }
    }
    for (const cinematic of definition?.cinematics || []) {
        (cinematic.captions || []).forEach((caption, index) => add(caption.text, {
            id: `cinematic.${cinematic.id}.${index}`, kind: 'cinematic-caption',
            speakerId: caption.speakerId || NARRATOR_SPEAKER_ID,
            mood: caption.mood || (caption.speakerId ? 'neutral' : 'narration'), cinematicId: cinematic.id,
            captionIndex: index, startMs: caption.startMs ?? 0, endMs: caption.endMs ?? null,
        }));
    }
    for (const scene of definition?.scenes || []) {
        for (const { effect, path } of sceneEffectGroups(scene)) {
            if (path[0] === 'resumeEffects') continue;
            const source = path[0] === 'onEnter'
                ? `onEnter.${path[1]}`
                : `${scene.transitions?.[path[1]]?.id}.${path[3]}`;
            if (effect?.type === 'ui.toast' && effect.speech === true) {
                add(effect.message, { id: `toast.${scene.id}.${source}`,
                    kind: 'toast', speakerId: effect.actorId || NARRATOR_SPEAKER_ID,
                    mood: effect.mood || 'neutral', sceneId: scene.id, durationMs: effect.durationMs ?? null });
            } else if (effect?.type === 'ui.captions') {
                // Narration over live play, voiced by the narrator like a film
                // caption; the same ids as core/campaign-voice-lines.js.
                (effect.captions || []).forEach((caption, index) => add(caption.text, {
                    id: `captions.${scene.id}.${source}.${index}`, kind: 'caption',
                    speakerId: caption.speakerId || NARRATOR_SPEAKER_ID,
                    mood: caption.mood || (caption.speakerId ? 'neutral' : 'narration'), sceneId: scene.id,
                    captionIndex: index, startMs: caption.startMs ?? 0, endMs: caption.endMs ?? null,
                }));
            }
        }
    }
    return byObject;
}

function inferMetadata(path, definition) {
    const [root, index, field, subIndex, leaf] = path;
    if (root === 'scenes' && isIndex(index)) {
        const scene = definition.scenes?.[index];
        if (field === 'objectives') return { kind: leaf === 'label' ? 'target' : 'objective', sceneId: scene?.id };
        if (field === 'authored') return { kind: 'label', sceneId: scene?.id };
        if (field === 'title') return { kind: 'title', sceneId: scene?.id };
        return { kind: 'metadata', sceneId: scene?.id };
    }
    if (root === 'journal') return { kind: 'journal', journalId: definition.journal?.[index]?.id || null,
        when: definition.journal?.[index]?.when || null };
    if (root === 'cinematics') return { kind: field === 'title' ? 'title' : 'metadata', cinematicId: definition.cinematics?.[index]?.id || null };
    if (root === 'conversations') {
        const conversation = definition.conversations?.[index];
        const beat = field === 'beats' ? conversation?.beats?.[subIndex] : null;
        return { kind: 'metadata', conversationId: conversation?.id || null,
            ...(beat && leaf === 'direction' ? { id: `direction.${conversation.id}.${beat.id}`, beatId: beat.id } : {}) };
    }
    if (root === 'actors') return { kind: 'label', actorId: definition.actors?.[index]?.id || null };
    return { kind: 'metadata' };
}

function captionMetadata(path, definition) {
    const sceneIndex = path[0] === 'scenes' ? path[1] : null;
    const scene = definition.scenes?.[sceneIndex];
    const captionAt = path.lastIndexOf('captions');
    const index = captionAt >= 0 ? path[captionAt + 1] : 0;
    return {
        id: `caption.${scene?.id || 'general'}.${path.slice(2, captionAt + 2).map(String).join('.')}`,
        // Only a caption track outside onEnter/transitions (a resume replay)
        // lands here; the live ones are narrator lines via voiceSources.
        kind: 'caption', spoken: false, speakerId: null, mood: 'narration',
        sceneId: scene?.id || null, captionIndex: isIndex(index) ? index : 0,
    };
}

function sourceLine(value, paths, definition, voices) {
    const primary = paths[0];
    const voice = voices.get(value);
    const caption = primary.includes('captions') && primary[0] === 'scenes';
    const metadata = voice || (caption ? captionMetadata(primary, definition) : inferMetadata(primary, definition));
    const text = textOf(value);
    const line = {
        id: metadata.id || `text.${primary.map(String).join('.')}`,
        ...metadata,
        hr: text.hr, en: text.en, text,
        hash: textHash(text.hr), characters: text.hr.length,
        spoken: metadata.spoken === true || Boolean(voice), path: primary, paths,
    };
    Object.defineProperty(line, 'source', { value, enumerable: false });
    return Object.freeze(line);
}

function interfaceLines(interfaceText) {
    const byKey = new Map();
    for (const entry of interfaceText || []) {
        const key = clean(entry?.key);
        if (!key || byKey.has(key)) continue;
        const text = textOf(entry);
        const line = { id: `ui.${key}`, kind: 'interface', i18nKey: key, hr: text.hr, en: text.en,
            text, hash: textHash(text.hr), characters: text.hr.length, spoken: false,
            path: ['interfaceText', key], paths: [['interfaceText', key]] };
        Object.defineProperty(line, 'source', { value: entry, enumerable: false });
        byKey.set(key, Object.freeze(line));
    }
    return byKey;
}

function effectLineIds(effect, absolutePath, pathToLine, uiByKey) {
    const ids = [];
    for (const paths of walkLocalized(effect).values()) {
        for (const relativePath of paths) {
            const line = pathToLine.get(pathKey([...absolutePath, ...relativePath]));
            if (line && !ids.includes(line.id)) ids.push(line.id);
        }
    }
    if (effect?.type === 'ui.toast' && effect.messageKey && uiByKey.has(effect.messageKey)) ids.push(`ui.${effect.messageKey}`);
    return ids;
}

const EXCERPT_CHARS = 40;

// A short quote of a line's Croatian text, for labels that say where a choice
// leads without repeating the whole line.
function excerpt(line) {
    const text = String(line?.hr || '').replace(/\s+/g, ' ').trim();
    return text.length > EXCERPT_CHARS ? `„${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…“` : `„${text}“`;
}

// A conversation laid out the way it is read. A line comes first, every
// answer the player can pick is listed together beneath it one level in, and
// then what follows. Answers that all lead to the same line merge back to the
// line's own level; answers that part ways each carry their continuation
// nested under them. A line reachable a second way is shown once, and a later
// answer that leads to it, or that ends the talk, says so instead.
function orderedConversationLines(conversation, lineById) {
    const beats = new Map((conversation?.beats || []).map(beat => [beat.id, beat]));
    const result = [];
    const shown = new Set();
    const beatLineId = beatId => `conversation.${conversation.id}.${beatId}`;
    const push = (id, depth, label = null, when = null) => {
        if (!lineById.has(id)) return null;
        const entry = { lineId: id, depth, label, when };
        result.push(entry);
        return entry;
    };
    const leadsTo = beatId => (beatId && beats.has(beatId)
        ? `vodi na ${excerpt(lineById.get(beatLineId(beatId)))}`
        : 'kraj razgovora');
    const visit = (startId, depth, firstLabel) => {
        let beatId = startId;
        let label = firstLabel;
        while (beatId && beats.has(beatId) && !shown.has(beatId)) {
            shown.add(beatId);
            const beat = beats.get(beatId);
            push(`direction.${conversation.id}.${beat.id}`, depth, 'Scenska uputa');
            const beatEntry = push(beatLineId(beat.id), depth, label);
            (beat.variants || []).forEach((variant, index) => push(`${beatLineId(beat.id)}.variant.${index}`, depth, null, variant.when || null));
            const responses = beat.responses || [];
            if (responses.length === 0) {
                // A line that runs straight on keeps its level; one that runs on
                // into something already shown points there.
                if (beat.nextBeatId && shown.has(beat.nextBeatId) && beatEntry) {
                    beatEntry.label = [beatEntry.label, leadsTo(beat.nextBeatId)].filter(Boolean).join(' · ');
                }
                beatId = beat.nextBeatId;
                label = null;
                continue;
            }
            const groups = [];
            for (const response of responses) {
                const target = beats.has(response.nextBeatId) ? response.nextBeatId : null;
                let group = groups.find(item => item.target === target);
                if (!group) groups.push(group = { target, responses: [] });
                group.responses.push(response);
            }
            const responseLineId = response => `${beatLineId(beat.id)}.${response.id}`;
            if (groups.length === 1) {
                const { target } = groups[0];
                const merges = Boolean(target) && !shown.has(target);
                for (const response of responses) push(responseLineId(response), depth + 1, merges ? null : leadsTo(target));
                beatId = merges ? target : null;
                label = merges && responses.length > 1 ? 'Nakon bilo kojeg odgovora' : null;
                continue;
            }
            for (const group of groups) {
                const nests = Boolean(group.target) && !shown.has(group.target);
                for (const response of group.responses) push(responseLineId(response), depth + 1, nests ? null : leadsTo(group.target));
                if (nests) {
                    const after = group.responses.map(response => excerpt(lineById.get(responseLineId(response)))).join(' ili ');
                    visit(group.target, depth + 2, `Nakon ${after}`);
                }
            }
            beatId = null;
        }
    };
    visit(conversation?.startBeatId, 0, 'Početak razgovora');
    for (const beat of conversation?.beats || []) {
        if (!shown.has(beat.id)) visit(beat.id, 0, 'Nije dostupno od početka razgovora');
    }
    return result;
}

function sectionEntry(line, label, when = null, depth = 0) {
    return Object.freeze({ lineId: line.id, label, ...(when ? { when } : {}), ...(depth > 0 ? { depth } : {}), path: line.path, paths: line.paths });
}

function conditionMentions(condition, value) {
    if (!condition || typeof condition !== 'object') return false;
    if (condition.flag === value || condition?.choice?.field === value) return true;
    return Object.values(condition).some(child => conditionMentions(child, value));
}

function sceneUnlocksJournal(scene, entry, definition) {
    if (entry?.when === true) return false;
    const when = entry?.when;
    for (const { effect } of sceneEffectGroups(scene)) {
        if (effect?.type === 'flag.set' && conditionMentions(when, effect.flag)) return true;
        if (effect?.type === 'conversation.start') {
            const conversation = (definition.conversations || []).find(item => item.id === effect.conversationId);
            if ((conversation?.beats || []).some(beat => (beat.responses || [])
                .some(response => response.rememberAs && conditionMentions(when, response.rememberAs)))) return true;
        }
    }
    return false;
}

function lineMatchesPrefix(line, prefix) {
    return line.paths.some(path => prefix.every((part, index) => path[index] === part));
}

function sceneSection(scene, sceneIndex, definition, lines, lineById, uiByKey, pathToLine, used) {
    const entries = [];
    const add = (line, label, when = null, depth = 0) => {
        if (!line || used.has(line.id)) return;
        used.add(line.id); entries.push(sectionEntry(line, label, when, depth));
    };
    const scenePrefix = ['scenes', sceneIndex];
    const sceneLines = lines.filter(line => lineMatchesPrefix(line, scenePrefix));
    const groups = sceneEffectGroups(scene);
    const effectPrefixes = groups.map(group => [...scenePrefix, ...group.path]);
    for (const line of sceneLines) {
        if (!effectPrefixes.some(prefix => lineMatchesPrefix(line, prefix))
            && !lineMatchesPrefix(line, [...scenePrefix, 'objectives'])) add(line, 'Scena');
    }
    // Actor labels belong with the first scene where that actor is introduced.
    for (const actor of scene.authored?.actors || []) {
        for (const line of lines.filter(item => item.actorId === actor.actorId)) add(line, 'Lik');
    }
    const addEffect = group => {
        const absolutePath = [...scenePrefix, ...group.path];
        for (const id of effectLineIds(group.effect, absolutePath, pathToLine, uiByKey)) {
            add(lineById.get(id), group.trigger ? `Nakon ${group.trigger.id}` : 'Pri ulasku', group.trigger?.when || null);
        }
        if (group.effect?.type === 'conversation.start') {
            const conversation = (definition.conversations || []).find(item => item.id === group.effect.conversationId);
            for (const entry of orderedConversationLines(conversation, lineById)) add(lineById.get(entry.lineId), entry.label, entry.when, entry.depth);
        }
        if (group.effect?.type === 'cinematic.start') {
            for (const line of lines.filter(item => item.cinematicId === group.effect.cinematicId)) add(line, 'Filmski prizor');
        }
        if (group.effect?.type === 'flag.set') {
            for (const line of lines.filter(item => item.kind === 'journal' && conditionMentions(item.when, group.effect.flag))) {
                add(line, 'Bilježnica', line.when);
            }
        }
    };
    for (const group of groups.filter(group => group.path[0] === 'onEnter')) addEffect(group);
    const authoredOrder = definition.scriptOrder?.[scene.id];
    if (authoredOrder) {
        for (const step of authoredOrder) {
            const [kind, id] = step.split(':');
            if (kind === 'objective') {
                const objectiveIndex = (scene.objectives || []).findIndex(item => item.id === id);
                if (objectiveIndex < 0) throw new Error(`Unknown script objective ${scene.id}/${id}`);
                for (const line of sceneLines.filter(item => lineMatchesPrefix(item, [...scenePrefix, 'objectives', objectiveIndex]))) add(line, 'Zadatak');
            } else if (kind === 'transition') {
                if (!(scene.transitions || []).some(item => item.id === id)) throw new Error(`Unknown script transition ${scene.id}/${id}`);
                for (const group of groups.filter(item => item.path[0] === 'transitions' && item.trigger.id === id)) addEffect(group);
            } else throw new Error(`Unknown script step ${step}`);
        }
    } else {
        for (const group of groups.filter(group => group.path[0] === 'transitions' && group.trigger?.event === 'session:ready')) addEffect(group);
    }
    for (const line of sceneLines.filter(line => lineMatchesPrefix(line, [...scenePrefix, 'objectives']))) add(line, 'Cilj');
    for (const group of groups.filter(group => group.path[0] === 'transitions' && group.trigger?.event !== 'session:ready')) addEffect(group);
    for (const group of groups.filter(group => group.path[0] === 'resumeEffects')) addEffect(group);
    for (const line of lines.filter(line => line.kind === 'journal'
        && sceneUnlocksJournal(scene, definition.journal?.find(entry => entry.id === line.journalId), definition))) {
        add(line, 'Bilježnica', line.when);
    }
    for (const line of sceneLines) add(line, 'Scena');
    return Object.freeze({ id: `scene.${scene.id}`, sceneId: scene.id, chapter: scene.chapter ?? null,
        title: textOf(scene.title), entries: Object.freeze(entries) });
}

// One line per localized object identity. Equal text in independently authored
// objects remains distinct; aliases retain every exact, numeric-aware path.
export function campaignScript(definition, { interfaceText = [] } = {}) {
    const found = walkLocalized(definition);
    const voices = voiceSources(definition);
    const lines = [...found].map(([source, paths]) => sourceLine(source, paths, definition, voices));
    const uiByKey = interfaceLines(interfaceText);
    lines.push(...uiByKey.values());
    const lineById = new Map(lines.map(line => [line.id, line]));
    const expectedVoiceIds = new Set(campaignVoiceLines(definition, { language: 'hr' }).map(line => line.id));
    for (const id of expectedVoiceIds) {
        if (!lineById.has(id)) throw new Error(`Campaign script omitted voice line "${id}".`);
    }
    const pathToLine = new Map(lines.flatMap(line => line.paths.map(path => [pathKey(path), line])));
    const used = new Set();
    const sections = [];
    for (const [sceneIndex, scene] of (definition?.scenes || []).entries()) {
        sections.push(sceneSection(scene, sceneIndex, definition, lines, lineById, uiByKey, pathToLine, used));
    }
    const general = [];
    for (const line of lines) {
        if (used.has(line.id)) continue;
        used.add(line.id);
        general.push(sectionEntry(line, line.kind === 'interface' ? 'Sučelje' : 'Općenito', line.when || null));
    }
    sections.unshift(Object.freeze({ id: 'general', sceneId: null, chapter: null,
        title: { hr: 'Izbornik i općenito', en: 'Menu and general' }, entries: Object.freeze(general) }));
    return Object.freeze({ lines: Object.freeze(lines), sections: Object.freeze(sections) });
}

export function scriptEntries(script) {
    return script?.lines || [];
}
