// Advances authored conversations and proves that every response path reaches
// a terminal beat without turning dialogue into mission scripting.

function beatMap(definition) {
    return new Map((definition?.beats || []).map(beat => [beat.id, beat]));
}

export function createConversationState(definition) {
    if (!definition?.startBeatId || !beatMap(definition).has(definition.startBeatId)) {
        throw new Error('Conversation start beat is unavailable.');
    }
    return {
        conversationId: definition.id,
        beatId: definition.startBeatId,
        responses: [],
        complete: false,
    };
}

export function currentConversationBeat(definition, state) {
    return beatMap(definition).get(state?.beatId) || null;
}

export function advanceConversation(definition, currentState, responseId = null) {
    if (currentState?.complete) return { state: currentState, remembered: null };
    const state = JSON.parse(JSON.stringify(currentState));
    const beat = currentConversationBeat(definition, state);
    if (!beat) throw new Error(`Unknown conversation beat "${state.beatId}".`);
    let nextBeatId = beat.nextBeatId || null;
    let remembered = null;
    if ((beat.responses || []).length > 0) {
        const response = beat.responses.find(item => item.id === responseId);
        if (!response) throw new Error(`Conversation response "${responseId}" is unavailable.`);
        state.responses.push({
            beatId: beat.id,
            responseId: response.id,
            tone: response.tone || 'neutral',
        });
        remembered = {
            key: response.rememberAs || definition.rememberAs || null,
            value: response.tone || response.id,
        };
        if (response.accepted === false) {
            return {
                state,
                remembered,
                rejected: true,
                rejection: response.rejection || null,
            };
        }
        nextBeatId = response.nextBeatId || beat.nextBeatId || null;
    }
    if (!nextBeatId) {
        state.complete = true;
        return { state, remembered };
    }
    if (!beatMap(definition).has(nextBeatId)) {
        throw new Error(`Conversation beat "${nextBeatId}" is unavailable.`);
    }
    state.beatId = nextBeatId;
    return { state, remembered };
}

export function conversationReconverges(definition) {
    const beats = beatMap(definition);
    const visiting = new Set();
    const settled = new Map();
    const reachesEnd = (beatId) => {
        if (!beatId) return true;
        if (!beats.has(beatId) || visiting.has(beatId)) return false;
        if (settled.has(beatId)) return settled.get(beatId);
        visiting.add(beatId);
        const beat = beats.get(beatId);
        const responses = beat.responses || [];
        const advancingResponses = responses.filter(response => response.accepted !== false);
        if (responses.length > 0 && advancingResponses.length === 0) return false;
        const targets = responses.length > 0
            ? advancingResponses.map(response => response.nextBeatId || beat.nextBeatId || null)
            : [beat.nextBeatId || null];
        const valid = targets.every(reachesEnd);
        visiting.delete(beatId);
        settled.set(beatId, valid);
        return valid;
    };
    return reachesEnd(definition?.startBeatId);
}

// Which conversation a scene starts when the player interacts with an entity.
// The link lives in the scene's transitions rather than on the actor, so it has
// to be read back out of them.
export function conversationIdForEntity(scene, entityId) {
    const id = String(entityId || '');
    if (!id) return null;
    for (const transition of scene?.transitions || []) {
        if (transition.event !== 'entity:interact') continue;
        const when = transition.when?.event;
        if (when?.field === 'entityId' && String(when.equals) !== id) continue;
        const start = (transition.effects || []).find(
            effect => effect.type === 'conversation.start',
        );
        if (start?.conversationId) return String(start.conversationId);
    }
    return null;
}

// True once the player has finished the conversation this entity offers, so the
// prompt can stop being shown. An entity may opt back in with `repeatable`, or
// remain available until a story flag proves that a branching exchange reached
// its successful ending.
export function entityConversationSpent(scene, authored, run) {
    if (!authored || authored.repeatable === true) return false;
    if (authored.repeatableUntilFlag
        && run?.flags?.[String(authored.repeatableUntilFlag)] !== true) return false;
    const conversationId = conversationIdForEntity(scene, authored.actorId);
    if (!conversationId) return false;
    return (run?.completedConversations || []).includes(conversationId);
}
