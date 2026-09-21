// Validates and freezes declarative campaign definitions before a run can
// start, keeping authored content out of executable runtime code.

import { validateCampaignCondition } from './campaign-conditions.js';
import { conversationReconverges } from './campaign-conversation.js';
import { finiteOrNull } from './math.js';
import { FACE_EXPRESSIONS } from './face-expressions.js';

export const CAMPAIGN_SCHEMA_VERSION = 1;

export const CAMPAIGN_ADAPTER_KINDS = Object.freeze([
    'walk',
    'gta',
    'heavy-rail',
]);

export const CAMPAIGN_ENVIRONMENT_KINDS = Object.freeze([
    'room',
    'set-piece',
]);
// An authored crowd: gatherings of people around a landmark, with shapes to
// keep clear of. Counts are capped so a scene cannot author a stampede.
export const CAMPAIGN_CROWD_MAX_PEOPLE = 240;

export const CAMPAIGN_EVENT_TYPES = Object.freeze([
    'campaign:start',
    'session:ready',
    'session:closed',
    'zone:entered',
    'zone:exited',
    'entity:interact',
    'item:presented',
    'environment:ready',
    'vehicle:boarded',
    'vehicle:exited',
    'vehicle:destroyed',
    'vehicle:abandoned',
    'rail:arrived',
    'rail:stopped',
    'rail:doors-opened',
    'rail:doors-closed',
    'rail:bell',
    'rail:brake-released',
    'rail:departed',
    'conversation:response',
    'conversation:complete',
    'cinematic:complete',
    'cinematic:skip',
    'encounter:escaped',
    'encounter:cleared',
    'encounter:failed',
    'player:failed',
    'player:landed',
    'player:bailed-out',
    'player:caught',
    'campaign:retry',
    'timer:elapsed',
]);

export const CAMPAIGN_EFFECT_TYPES = Object.freeze([
    'scene.open',
    'flag.set',
    'inventory.grant',
    'inventory.remove',
    'objective.complete',
    'scene.complete',
    'conversation.start',
    'cinematic.start',
    'cinematic.unlock',
    'actor.spawn',
    'actor.despawn',
    'actor.attach',
    'rail-vehicle.board',
    'rail-vehicle.disembark.enable',
    'rail-vehicle.derail',
    'vehicle.fail',
    'vehicle.retire',
    'player.parachute',
    'encounter.start',
    'encounter.stop',
    'checkpoint.commit',
    'world-effect.apply',
    'world-effect.remove',
    'campaign.fail',
    'campaign.complete',
    'choice.remember',
    'ui.toast',
    'ui.captions',
]);

function duplicateIds(items, path, errors) {
    const seen = new Set();
    for (const item of items || []) {
        const id = String(item?.id || '').trim();
        if (!id) {
            errors.push(`${path} contains an item without an id.`);
        } else if (seen.has(id)) {
            errors.push(`${path} contains duplicate id "${id}".`);
        }
        seen.add(id);
    }
}

function requireLocalized(value, path, errors, locales) {
    for (const locale of locales) {
        if (typeof value?.[locale] !== 'string' || !value[locale].trim()) {
            errors.push(`${path}.${locale} is required.`);
        }
    }
}

function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

// A caption spoken by a character ("VIKI: „…“") names an actor as its
// speaker and shows the name as a label; a stage cue is shown before the text.
// The speaker's own voice reads the text, so a typo here would silently hand
// the line back to the narrator.
function finitePoint(point) {
    return !!point && finiteOrNull(point.lat) != null && finiteOrNull(point.lon) != null;
}

function validateCrowd(crowd, path, errors) {
    if (!Array.isArray(crowd.gatherings) || crowd.gatherings.length === 0) {
        errors.push(`${path}.gatherings must list at least one gathering.`);
        return;
    }
    let total = 0;
    for (const [index, gathering] of crowd.gatherings.entries()) {
        const gatheringPath = `${path}.gatherings[${index}]`;
        if (!finitePoint(gathering)) errors.push(`${gatheringPath} must contain finite lat/lon.`);
        if (!(finiteOrNull(gathering.radiusM) > 0)) errors.push(`${gatheringPath}.radiusM must be positive.`);
        if (gathering.innerRadiusM != null && !(finiteOrNull(gathering.innerRadiusM) >= 0)) {
            errors.push(`${gatheringPath}.innerRadiusM must be zero or more.`);
        }
        if (!Number.isInteger(gathering.count) || gathering.count < 1) {
            errors.push(`${gatheringPath}.count must be a positive integer.`);
        } else {
            total += gathering.count;
        }
    }
    if (total > CAMPAIGN_CROWD_MAX_PEOPLE) {
        errors.push(`${path} authors ${total} people; the cap is ${CAMPAIGN_CROWD_MAX_PEOPLE}.`);
    }
    if (crowd.focus != null && !finitePoint(crowd.focus)) errors.push(`${path}.focus must contain finite lat/lon.`);
    if (crowd.cameraShare != null) {
        const share = finiteOrNull(crowd.cameraShare);
        if (share == null || share < 0 || share > 1) errors.push(`${path}.cameraShare must be between 0 and 1.`);
    }
    for (const [index, shape] of (crowd.keepClear || []).entries()) {
        const shapePath = `${path}.keepClear[${index}]`;
        if (!finitePoint(shape)) errors.push(`${shapePath} must contain finite lat/lon.`);
        const disc = finiteOrNull(shape.radiusM) > 0;
        const rect = finiteOrNull(shape.widthM) > 0 && finiteOrNull(shape.depthM) > 0;
        if (!disc && !rect) errors.push(`${shapePath} needs a positive radiusM or widthM and depthM.`);
        if (shape.rotationDeg != null && finiteOrNull(shape.rotationDeg) == null) {
            errors.push(`${shapePath}.rotationDeg must be finite.`);
        }
    }
}

function validateCaptionSpeaker(caption, path, errors, refs) {
    if (caption?.speakerId != null && !refs.actorIds.has(caption.speakerId)) {
        errors.push(`${path} names unknown speaker "${caption.speakerId}".`);
    }
    if (caption?.label != null) requireLocalized(caption.label, `${path}.label`, errors, refs.locales);
    if (caption?.cue != null) requireLocalized(caption.cue, `${path}.cue`, errors, refs.locales);
}

function validateEffect(effect, path, errors, refs) {
    if (!CAMPAIGN_EFFECT_TYPES.includes(effect?.type)) {
        errors.push(`${path} uses unknown effect "${effect?.type || ''}".`);
        return;
    }
    if (effect.type === 'conversation.start' && !refs.conversationIds.has(effect.conversationId)) {
        errors.push(`${path} references unknown conversation "${effect.conversationId}".`);
    }
    if (['cinematic.start', 'cinematic.unlock'].includes(effect.type)
        && !refs.cinematicIds.has(effect.cinematicId)) {
        errors.push(`${path} references unknown cinematic "${effect.cinematicId}".`);
    }
    if (['actor.spawn', 'actor.despawn', 'actor.attach'].includes(effect.type)
        && !refs.actorIds.has(effect.actorId)) {
        errors.push(`${path} references unknown actor "${effect.actorId}".`);
    }
    if (['rail-vehicle.board', 'rail-vehicle.derail', 'vehicle.fail', 'vehicle.retire'].includes(effect.type)
        && !String(effect.vehicleId || '').trim()) {
        errors.push(`${path}.vehicleId is required.`);
    }
    if (effect.type === 'player.parachute') {
        // The canopy opens at an authored spot: metres above the sea, compass heading.
        for (const field of ['lat', 'lon', 'altitudeM']) {
            if (!Number.isFinite(effect[field])) errors.push(`${path}.${field} must be a finite number.`);
        }
        if (Number.isFinite(effect.altitudeM) && effect.altitudeM <= 0) errors.push(`${path}.altitudeM must be above the sea.`);
        if (effect.headingDeg != null && !Number.isFinite(effect.headingDeg)) errors.push(`${path}.headingDeg must be a finite number.`);
    }
    if (effect.type === 'ui.captions') {
        if (!Array.isArray(effect.captions) || effect.captions.length === 0) {
            errors.push(`${path}.captions must be a non-empty array.`);
        }
        for (const [captionIndex, caption] of (effect.captions || []).entries()) {
            const captionPath = `${path}.captions[${captionIndex}]`;
            requireLocalized(caption?.text, `${captionPath}.text`, errors, refs.locales);
            validateCaptionSpeaker(caption, captionPath, errors, refs);
            const startMs = finiteOrNull(caption?.startMs) ?? 0;
            const endMs = finiteOrNull(caption?.endMs);
            if (startMs < 0 || endMs == null || endMs <= startMs) {
                errors.push(`${captionPath} needs startMs before a finite endMs.`);
            }
        }
    }
    if (['inventory.grant', 'inventory.remove'].includes(effect.type)
        && !refs.inventoryIds.has(effect.itemId)) {
        errors.push(`${path} references unknown inventory item "${effect.itemId}".`);
    }
    if (['encounter.start', 'encounter.stop'].includes(effect.type)
        && !refs.encounterIds.has(effect.encounterId)) {
        errors.push(`${path} references unknown encounter "${effect.encounterId}".`);
    }
    if (['world-effect.apply', 'world-effect.remove'].includes(effect.type)
        && !refs.worldEffectIds.has(effect.worldEffectId)) {
        errors.push(`${path} references unknown world effect "${effect.worldEffectId}".`);
    }
}

function validateConversation(conversation, path, errors, locales, refs) {
    duplicateIds(conversation?.beats, `${path}.beats`, errors);
    const beats = new Map((conversation?.beats || []).map(beat => [beat.id, beat]));
    if (!conversation?.startBeatId || !beats.has(conversation.startBeatId)) {
        errors.push(`${path}.startBeatId does not resolve.`);
    }
    for (const beat of conversation?.beats || []) {
        requireLocalized(beat.text, `${path}.beats.${beat.id}.text`, errors, locales);
        if (beat.prompt != null) {
            // A prompt from the game itself (no speaker): its eyebrow label.
            requireLocalized(beat.prompt, `${path}.beats.${beat.id}.prompt`, errors, locales);
        }
        if (beat.direction != null) {
            requireLocalized(beat.direction, `${path}.beats.${beat.id}.direction`, errors, locales);
        }
        if (beat.pauseBeforeMs != null
            && (!Number.isFinite(beat.pauseBeforeMs) || beat.pauseBeforeMs < 0)) {
            errors.push(`${path}.beats.${beat.id}.pauseBeforeMs must be a nonnegative finite number.`);
        }
        for (const [variantIndex, variant] of (beat.variants || []).entries()) {
            requireLocalized(
                variant.text,
                `${path}.beats.${beat.id}.variants[${variantIndex}].text`,
                errors,
                locales,
            );
            errors.push(...validateCampaignCondition(
                variant.when,
                `${path}.beats.${beat.id}.variants[${variantIndex}].when`,
            ));
        }
        if (beat.speakerId && !refs.actorIds.has(beat.speakerId)) {
            errors.push(`${path}.beats.${beat.id} references unknown speaker "${beat.speakerId}".`);
        }
        if (beat.mood != null && !FACE_EXPRESSIONS.includes(beat.mood)) {
            errors.push(`${path}.beats.${beat.id}.mood "${beat.mood}" is not a face expression.`);
        }
        duplicateIds(beat.responses, `${path}.beats.${beat.id}.responses`, errors);
        if (beat.nextBeatId && !beats.has(beat.nextBeatId)) {
            errors.push(`${path}.beats.${beat.id}.nextBeatId does not resolve.`);
        }
        for (const response of beat.responses || []) {
            requireLocalized(response.text, `${path}.beats.${beat.id}.responses.${response.id}.text`, errors, locales);
            if (response.accepted === false) {
                requireLocalized(
                    response.rejection,
                    `${path}.beats.${beat.id}.responses.${response.id}.rejection`,
                    errors,
                    locales,
                );
            }
            if (response.nextBeatId && !beats.has(response.nextBeatId)) {
                errors.push(`${path}.beats.${beat.id}.responses.${response.id}.nextBeatId does not resolve.`);
            }
        }
    }
    if (!conversationReconverges(conversation)) {
        errors.push(`${path} contains a cycle or response path without a terminal beat.`);
    }
}

function reachableSceneIds(definition) {
    const seen = new Set();
    const queue = [definition.startSceneId];
    const byId = new Map((definition.scenes || []).map(scene => [scene.id, scene]));
    while (queue.length > 0) {
        const id = queue.shift();
        if (!id || seen.has(id) || !byId.has(id)) continue;
        seen.add(id);
        for (const transition of byId.get(id).transitions || []) {
            if (transition.targetSceneId && !seen.has(transition.targetSceneId)) {
                queue.push(transition.targetSceneId);
            }
        }
    }
    return seen;
}

export function validateCampaignDefinition(definition, { locales = ['en', 'hr'] } = {}) {
    const errors = [];
    if (!definition || typeof definition !== 'object') return ['Campaign definition is required.'];
    if (!String(definition.id || '').trim()) errors.push('id is required.');
    if (!Number.isInteger(definition.version) || definition.version < 1) {
        errors.push('version must be a positive integer.');
    }
    requireLocalized(definition.metadata?.title, 'metadata.title', errors, locales);
    requireLocalized(definition.metadata?.summary, 'metadata.summary', errors, locales);
    duplicateIds(definition.scenes, 'scenes', errors);
    duplicateIds(definition.conversations, 'conversations', errors);
    duplicateIds(definition.cinematics, 'cinematics', errors);
    duplicateIds(definition.actors, 'actors', errors);
    duplicateIds(definition.encounters, 'encounters', errors);
    duplicateIds(definition.inventoryItems, 'inventoryItems', errors);
    duplicateIds(definition.worldEffects, 'worldEffects', errors);
    duplicateIds(definition.journal, 'journal', errors);
    for (const entry of definition.journal || []) {
        requireLocalized(entry.title, 'journal.title', errors, locales);
        requireLocalized(entry.text, 'journal.text', errors, locales);
        errors.push(...validateCampaignCondition(entry.when, 'journal.when'));
        errors.push(...validateCampaignCondition(entry.presentWhen, 'journal.presentWhen'));
    }


    const sceneIds = new Set((definition.scenes || []).map(scene => scene.id));
    const refs = {
        locales,
        conversationIds: new Set((definition.conversations || []).map(item => item.id)),
        cinematicIds: new Set((definition.cinematics || []).map(item => item.id)),
        actorIds: new Set((definition.actors || []).map(item => item.id)),
        encounterIds: new Set((definition.encounters || []).map(item => item.id)),
        inventoryIds: new Set((definition.inventoryItems || []).map(item => item.id)),
        worldEffectIds: new Set((definition.worldEffects || []).map(item => item.id)),
    };
    if (!sceneIds.has(definition.startSceneId)) errors.push('startSceneId does not resolve.');

    for (const [sceneIndex, scene] of (definition.scenes || []).entries()) {
        const path = `scenes[${sceneIndex}]`;
        if (!CAMPAIGN_ADAPTER_KINDS.includes(scene.adapter)) {
            errors.push(`${path} uses unknown adapter "${scene.adapter || ''}".`);
        }
        if (!scene.checkpoint?.id || !scene.checkpoint?.pose) {
            errors.push(`${path} must have a restorable checkpoint with a pose.`);
        } else if (finiteOrNull(scene.checkpoint.pose.lat) == null
            || finiteOrNull(scene.checkpoint.pose.lon) == null
            || (scene.checkpoint.pose.headingDeg != null
                && finiteOrNull(scene.checkpoint.pose.headingDeg) == null)) {
            errors.push(`${path}.checkpoint.pose must contain finite lat/lon and an optional finite headingDeg.`);
        }
        duplicateIds(scene.checkpoint?.linkEntries, `${path}.checkpoint.linkEntries`, errors);
        for (const [entryIndex, entry] of (scene.checkpoint?.linkEntries || []).entries()) {
            const entryPath = `${path}.checkpoint.linkEntries[${entryIndex}]`;
            if (entry.id === scene.checkpoint.id) {
                errors.push(`${entryPath}.id duplicates the primary checkpoint.`);
            }
            if (!entry.pose
                || finiteOrNull(entry.pose.lat) == null
                || finiteOrNull(entry.pose.lon) == null
                || (entry.pose.headingDeg != null
                    && finiteOrNull(entry.pose.headingDeg) == null)) {
                errors.push(`${entryPath}.pose must contain finite lat/lon and an optional finite headingDeg.`);
            }
        }
        requireLocalized(scene.title, `${path}.title`, errors, locales);
        duplicateIds(scene.objectives, `${path}.objectives`, errors);
        duplicateIds(scene.transitions, `${path}.transitions`, errors);
        for (const [actorIndex, actor] of (scene.authored?.actors || []).entries()) {
            if (!refs.actorIds.has(actor.actorId)) {
                errors.push(`${path}.authored.actors[${actorIndex}] references unknown actor "${actor.actorId}".`);
            }
        }
        for (const [index, item] of (scene.authored?.interactables || []).entries()) {
            const itemPath = `${path}.authored.interactables[${index}]`;
            if (!String(item?.id || '').trim()) errors.push(`${itemPath}.id is required.`);
            if (!finitePoint(item)) errors.push(`${itemPath} must contain finite lat/lon.`);
            if (item?.radiusM != null && finiteOrNull(item.radiusM) == null) {
                errors.push(`${itemPath}.radiusM must be finite.`);
            }
            requireLocalized(item?.label, `${itemPath}.label`, errors, locales);
        }
        if (scene.authored?.crowd) validateCrowd(scene.authored.crowd, `${path}.authored.crowd`, errors);
        if (scene.authored?.environment
            && !CAMPAIGN_ENVIRONMENT_KINDS.includes(scene.authored.environment.kind)) {
            errors.push(`${path}.authored.environment uses unknown kind "${scene.authored.environment.kind || ''}".`);
        }
        if (scene.authored?.encounter?.id
            && !refs.encounterIds.has(scene.authored.encounter.id)) {
            errors.push(`${path}.authored.encounter references unknown encounter "${scene.authored.encounter.id}".`);
        }
        for (const [objectiveIndex, objective] of (scene.objectives || []).entries()) {
            requireLocalized(objective.text, `${path}.objectives[${objectiveIndex}].text`, errors, locales);
            errors.push(...validateCampaignCondition(
                objective.completeWhen,
                `${path}.objectives[${objectiveIndex}].completeWhen`,
            ));
        }
        for (const [transitionIndex, transition] of (scene.transitions || []).entries()) {
            const transitionPath = `${path}.transitions[${transitionIndex}]`;
            if (!CAMPAIGN_EVENT_TYPES.includes(transition.event)) {
                errors.push(`${transitionPath} uses unknown event "${transition.event || ''}".`);
            }
            if (transition.targetSceneId && !sceneIds.has(transition.targetSceneId)) {
                errors.push(`${transitionPath} targets unknown scene "${transition.targetSceneId}".`);
            }
            errors.push(...validateCampaignCondition(transition.when, `${transitionPath}.when`));
            (transition.effects || []).forEach((effect, effectIndex) => (
                validateEffect(effect, `${transitionPath}.effects[${effectIndex}]`, errors, refs)
            ));
        }
        (scene.onEnter || []).forEach((effect, effectIndex) => (
            validateEffect(effect, `${path}.onEnter[${effectIndex}]`, errors, refs)
        ));
        for (const [resumeIndex, resume] of (scene.resumeEffects || []).entries()) {
            const resumePath = `${path}.resumeEffects[${resumeIndex}]`;
            errors.push(...validateCampaignCondition(resume.when, `${resumePath}.when`));
            (resume.effects || []).forEach((effect, effectIndex) => (
                validateEffect(effect, `${resumePath}.effects[${effectIndex}]`, errors, refs)
            ));
        }
    }

    (definition.conversations || []).forEach((conversation, index) => (
        validateConversation(conversation, `conversations[${index}]`, errors, locales, refs)
    ));
    (definition.actors || []).forEach((actor, index) => (
        requireLocalized(actor.label, `actors[${index}].label`, errors, locales)
    ));
    (definition.inventoryItems || []).forEach((item, index) => (
        requireLocalized(item.label, `inventoryItems[${index}].label`, errors, locales)
    ));
    for (const [index, cinematic] of (definition.cinematics || []).entries()) {
        requireLocalized(cinematic.title, `cinematics[${index}].title`, errors, locales);
        if (cinematic.replaySceneId && !sceneIds.has(cinematic.replaySceneId)) {
            errors.push(`cinematics[${index}].replaySceneId does not resolve.`);
        }
        if (cinematic.replayPose && ![cinematic.replayPose.lat, cinematic.replayPose.lon, cinematic.replayPose.headingDeg].every(Number.isFinite)) {
            errors.push(`cinematics[${index}].replayPose must contain a finite latitude, longitude and heading.`);
        }
        for (const [effectIndex, effect] of (cinematic.replayEffects || []).entries()) {
            validateEffect(effect, `cinematics[${index}].replayEffects[${effectIndex}]`, errors, refs);
        }
        if (!(Number(cinematic.durationMs) > 0)) {
            errors.push(`cinematics[${index}].durationMs must be positive.`);
        }
        if (!Array.isArray(cinematic.keyframes) || cinematic.keyframes.length < 2) {
            errors.push(`cinematics[${index}].keyframes must contain at least two entries.`);
        }
        for (const [frameIndex, frame] of (Array.isArray(cinematic.keyframes) ? cinematic.keyframes : []).entries()) {
            const camera = frame?.camera;
            if (!camera || camera.relativeTo == null) continue;
            const framePath = `cinematics[${index}].keyframes[${frameIndex}].camera`;
            if (camera.relativeTo !== 'player') {
                errors.push(`${framePath}.relativeTo must be "player".`);
                continue;
            }
            for (const point of ['position', 'lookAt']) {
                if (![camera[point]?.rightM, camera[point]?.upM, camera[point]?.forwardM].every(Number.isFinite)) {
                    errors.push(`${framePath}.${point} must carry finite rightM, upM and forwardM offsets.`);
                }
            }
        }
        if (cinematic.artwork) {
            if (typeof cinematic.artwork.src !== 'string' || !cinematic.artwork.src.trim()) {
                errors.push(`cinematics[${index}].artwork.src is required.`);
            }
            requireLocalized(
                cinematic.artwork.alt,
                `cinematics[${index}].artwork.alt`,
                errors,
                locales,
            );
            const startMs = finiteOrNull(cinematic.artwork.startMs) ?? 0;
            const endMs = finiteOrNull(cinematic.artwork.endMs)
                ?? Number(cinematic.durationMs);
            if (startMs < 0 || endMs <= startMs || endMs > Number(cinematic.durationMs)) {
                errors.push(`cinematics[${index}].artwork timing must fit inside the cinematic.`);
            }
        }
        if (cinematic.newspapers != null) {
            if (!Array.isArray(cinematic.newspapers) || cinematic.newspapers.length === 0) {
                errors.push(`cinematics[${index}].newspapers must contain at least one front page.`);
            }
            let previousEndMs = 0;
            for (const [paperIndex, paper] of (Array.isArray(cinematic.newspapers) ? cinematic.newspapers : []).entries()) {
                const path = `cinematics[${index}].newspapers[${paperIndex}]`;
                if (typeof paper?.masthead !== 'string' || !paper.masthead.trim()) errors.push(`${path}.masthead is required.`);
                for (const field of ['headline', 'edition', 'deck', 'summary']) {
                    requireLocalized(paper?.[field], `${path}.${field}`, errors, locales);
                }
                if (paper?.imageSrc) requireLocalized(paper.imageAlt, `${path}.imageAlt`, errors, locales);
                const startMs = finiteOrNull(paper?.startMs);
                const endMs = finiteOrNull(paper?.endMs);
                if (startMs == null || endMs == null || startMs < previousEndMs || endMs - startMs < 4000 || endMs > Number(cinematic.durationMs)) {
                    errors.push(`${path} must have at least 4000 ms, fit inside the cinematic and not overlap another page.`);
                }
                previousEndMs = endMs ?? previousEndMs;
            }
        }
        for (const [captionIndex, caption] of (cinematic.captions || []).entries()) {
            requireLocalized(caption.text, `cinematics[${index}].captions[${captionIndex}].text`, errors, locales);
            validateCaptionSpeaker(caption, `cinematics[${index}].captions[${captionIndex}]`, errors, refs);
        }
    }

    const reachable = reachableSceneIds(definition);
    for (const scene of definition.scenes || []) {
        if (!scene.optional && !reachable.has(scene.id)) {
            errors.push(`Required scene "${scene.id}" is unreachable.`);
        }
    }
    return errors;
}

export function defineCampaign(definition, options) {
    const errors = validateCampaignDefinition(definition, options);
    if (errors.length > 0) {
        throw new Error(`Invalid campaign definition:\n- ${errors.join('\n- ')}`);
    }
    return deepFreeze(definition);
}

export function campaignScene(definition, sceneId) {
    return (definition?.scenes || []).find(scene => scene.id === sceneId) || null;
}

export function campaignAsset(definition, collection, id) {
    return (definition?.[collection] || []).find(item => item.id === id) || null;
}
