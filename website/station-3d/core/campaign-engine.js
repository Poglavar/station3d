// Pure campaign reducer and checkpoint restoration. Browser sessions apply
// returned effects; this module owns only serializable story state.

import { campaignEventField, evaluateCampaignCondition } from './campaign-conditions.js';
import { CAMPAIGN_SCHEMA_VERSION, campaignScene } from './campaign-definition.js';
import { finiteOrNull } from './math.js';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniquePush(array, value) {
    if (!array.includes(value)) array.push(value);
}

function checkpointState(run) {
    return clone({
        currentSceneId: run.currentSceneId,
        completedScenes: run.completedScenes,
        completedObjectives: run.completedObjectives,
        completedConversations: run.completedConversations,
        flags: run.flags,
        inventory: run.inventory,
        choices: run.choices,
        unlockedCinematics: run.unlockedCinematics,
        worldEffects: run.worldEffects,
        entryCheckpointId: run.entryCheckpointId || null,
        completed: run.completed,
        completedAt: run.completedAt,
    });
}

function commitCheckpoint(run, checkpointId, timestamp) {
    run.checkpointId = checkpointId;
    run.checkpoint = {
        id: checkpointId,
        sceneId: run.currentSceneId,
        savedAt: timestamp,
        state: checkpointState(run),
    };
}

function effectValue(effect, event) {
    if (typeof effect.valueFromEvent === 'string') {
        return campaignEventField(event, effect.valueFromEvent);
    }
    return clone(effect.value);
}

function applyStateEffect(run, effect, event, timestamp) {
    switch (effect.type) {
    case 'flag.set':
        run.flags[effect.flag] = effectValue(effect, event) ?? true;
        break;
    case 'inventory.grant': {
        const count = Math.max(1, Number(effect.count) || 1);
        run.inventory[effect.itemId] = (Number(run.inventory[effect.itemId]) || 0) + count;
        break;
    }
    case 'inventory.remove': {
        const count = Math.max(1, Number(effect.count) || 1);
        const next = Math.max(0, (Number(run.inventory[effect.itemId]) || 0) - count);
        if (next > 0) run.inventory[effect.itemId] = next;
        else delete run.inventory[effect.itemId];
        break;
    }
    case 'objective.complete':
        uniquePush(run.completedObjectives, effect.objectiveId);
        break;
    case 'scene.complete':
        uniquePush(run.completedScenes, effect.sceneId || run.currentSceneId);
        break;
    case 'choice.remember':
        run.choices[effect.key] = effectValue(effect, event);
        break;
    case 'cinematic.unlock':
        uniquePush(run.unlockedCinematics, effect.cinematicId);
        break;
    case 'world-effect.apply':
        run.worldEffects[effect.worldEffectId] = effect.stage ?? true;
        break;
    case 'world-effect.remove':
        delete run.worldEffects[effect.worldEffectId];
        break;
    case 'campaign.complete':
        run.completed = true;
        run.completedAt = timestamp;
        break;
    default:
        break;
    }
}

function eventToken(sceneId, transition, event) {
    const identity = event.eventId || event.id || JSON.stringify(event);
    return `${sceneId}:${transition.id}:${identity}`;
}

function enterScene(definition, run, sceneId, effects, timestamp) {
    const scene = campaignScene(definition, sceneId);
    if (!scene) throw new Error(`Unknown campaign scene "${sceneId}".`);
    run.currentSceneId = scene.id;
    run.entryCheckpointId = scene.checkpoint?.id || null;
    effects.push({ type: 'scene.open', sceneId: scene.id });
    for (const effect of scene.onEnter || []) {
        applyStateEffect(run, effect, {}, timestamp);
        effects.push(clone(effect));
    }
    if (scene.checkpoint?.id) commitCheckpoint(run, scene.checkpoint.id, timestamp);
}

export function startCampaignRun(definition, {
    runId = `${definition.id}:local`,
    timestamp = 0,
} = {}) {
    const run = {
        schemaVersion: CAMPAIGN_SCHEMA_VERSION,
        campaignId: definition.id,
        campaignVersion: definition.version,
        runId,
        currentSceneId: definition.startSceneId,
        checkpointId: null,
        checkpoint: null,
        completedScenes: [],
        completedObjectives: [],
        completedConversations: [],
        flags: {},
        inventory: {},
        choices: {},
        unlockedCinematics: [],
        worldEffects: {},
        processedTransitions: [],
        completed: false,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
    };
    const effects = [];
    enterScene(definition, run, definition.startSceneId, effects, timestamp);
    return { run, effects, checkpointChanged: true };
}

// Local checkpoint links use the real reducer/director from a canonical story
// state instead of opening a disconnected transport scenario. The caller owns
// the seed; this helper only normalizes the serializable run fields and enters
// the scene through the same path as an ordinary campaign transition.
export function startCampaignRunAtCheckpoint(definition, checkpointId, {
    state = {},
    runId = `${definition.id}:local`,
    timestamp = 0,
} = {}) {
    const id = String(checkpointId || '').trim();
    const scene = (definition.scenes || []).find(item => (
        item.checkpoint?.id === id
        || (item.checkpoint?.linkEntries || []).some(entry => entry?.id === id)
    ));
    if (!scene) throw new Error(`Unknown campaign checkpoint "${id}".`);
    const base = startCampaignRun(definition, { runId, timestamp }).run;
    const seeded = {
        ...base,
        completedScenes: clone(state.completedScenes || []),
        completedObjectives: clone(state.completedObjectives || []),
        completedConversations: clone(state.completedConversations || []),
        flags: clone(state.flags || {}),
        inventory: clone(state.inventory || {}),
        choices: clone(state.choices || {}),
        unlockedCinematics: clone(state.unlockedCinematics || []),
        worldEffects: clone(state.worldEffects || {}),
        processedTransitions: [],
        completed: false,
        completedAt: null,
        updatedAt: timestamp,
    };
    const effects = [];
    enterScene(definition, seeded, scene.id, effects, timestamp);
    // A seed describes the world AT the checkpoint, which is later than scene
    // entry: a stage it names (the chase bed on a mid-scene link) overrides
    // what onEnter just applied; stages it leaves out keep the entry value.
    Object.assign(seeded.worldEffects, clone(state.worldEffects || {}));
    seeded.entryCheckpointId = id;
    commitCheckpoint(seeded, id, timestamp);
    return { run: seeded, effects, checkpointChanged: true };
}

export function reduceCampaign(definition, currentRun, inputEvent) {
    const run = clone(currentRun);
    const event = clone(inputEvent || {});
    const timestamp = finiteOrNull(event.timestamp) != null
        ? finiteOrNull(event.timestamp)
        : run.updatedAt;
    const effects = [];
    let checkpointChanged = false;
    const scene = campaignScene(definition, run.currentSceneId);
    if (!scene || !event.type) return { run, effects, checkpointChanged };

    // Record a finished conversation once. Scene actors normally stop offering
    // a recorded conversation; authored branching exchanges may remain
    // repeatable until a separate success flag is set.
    if (event.type === 'conversation:complete' && event.conversationId) {
        if (!Array.isArray(run.completedConversations)) run.completedConversations = [];
        uniquePush(run.completedConversations, String(event.conversationId));
    }

    // Objectives are swept twice: once against the incoming event, and again
    // after a transition's effects land. A transition that both sets a flag and
    // leaves the scene would otherwise strand the objective gated on that flag
    // — `flight-survive` waits on `vis-plane-lost`, which the same transition
    // that enters Vis sets, so the chapter's own objective never completed.
    const sweepObjectives = () => {
        for (const objective of scene.objectives || []) {
            if (run.completedObjectives.includes(objective.id)) continue;
            if (!evaluateCampaignCondition(objective.completeWhen, { run, event })) continue;
            uniquePush(run.completedObjectives, objective.id);
            effects.push({ type: 'objective.complete', objectiveId: objective.id });
        }
    };
    sweepObjectives();

    for (const transition of scene.transitions || []) {
        if (transition.event !== event.type) continue;
        if (!evaluateCampaignCondition(transition.when, { run, event })) continue;
        const token = eventToken(scene.id, transition, event);
        if (run.processedTransitions.includes(token)) continue;
        uniquePush(run.processedTransitions, token);
        for (const effect of transition.effects || []) {
            applyStateEffect(run, effect, event, timestamp);
            effects.push(clone(effect));
            if (effect.type === 'checkpoint.commit') {
                const committedId = effect.checkpointId || scene.checkpoint.id;
                // Committing one of the scene's link entries moves the resume
                // pose there, so a later retry restarts at that point, not at
                // the scene start.
                if ((scene.checkpoint?.linkEntries || []).some(entry => entry?.id === committedId)) {
                    run.entryCheckpointId = committedId;
                }
                commitCheckpoint(run, committedId, timestamp);
                checkpointChanged = true;
            }
        }
        // Still the outgoing scene here: credit anything its own effects just
        // satisfied before the run moves on.
        sweepObjectives();
        if (transition.targetSceneId) {
            uniquePush(run.completedScenes, scene.id);
            enterScene(definition, run, transition.targetSceneId, effects, timestamp);
            checkpointChanged = true;
        }
        if (transition.stop !== false) break;
    }
    run.updatedAt = timestamp;
    return { run, effects, checkpointChanged };
}

export function restoreCampaignCheckpoint(currentRun, timestamp = currentRun?.updatedAt || 0) {
    if (!currentRun?.checkpoint?.state) throw new Error('Campaign checkpoint is unavailable.');
    const restored = {
        ...clone(currentRun),
        ...clone(currentRun.checkpoint.state),
        checkpointId: currentRun.checkpoint.id,
        checkpoint: clone(currentRun.checkpoint),
        processedTransitions: [],
        updatedAt: timestamp,
    };
    return restored;
}

export function currentCampaignObjective(definition, run) {
    const scene = campaignScene(definition, run?.currentSceneId);
    return (scene?.objectives || []).find(
        objective => !(run?.completedObjectives || []).includes(objective.id),
    ) || null;
}
