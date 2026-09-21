// Conversation cadence and playback lifecycle, independent of Three.js and
// Web Audio. The world supplies actual members; audio follows the current one.
import {
    CONVERSATION_PAIR_SEPARATION_M,
    CONVERSATION_START_DISTANCE_M,
    conversationSpatial,
    nextConversationDelayS,
    pedestrianConversationLine,
    pedestrianConversationsForCity,
    PEDESTRIAN_CONVERSATIONS,
} from './pedestrian-conversations.js';

export function conversationPairSpatial(members, listener, { starting = false } = {}) {
    if (!listener || members?.length !== 2) return null;
    const [a, b] = members;
    if (!a?.person || !b?.person || a.person === b.person) return null;
    if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > CONVERSATION_PAIR_SEPARATION_M) return null;
    const spatial = members.map(member => conversationSpatial({
        sourceX: member.x, sourceY: member.y, sourceZ: member.z,
        cameraX: listener.x, cameraY: listener.y, cameraZ: listener.z,
        cameraRightX: listener.rightX, cameraRightZ: listener.rightZ,
    }));
    if (spatial.some(value => !value || (starting && value.distanceM > CONVERSATION_START_DISTANCE_M))) return null;
    return spatial;
}

export function createPedestrianConversationController({
    getPairs,
    getMembers,
    getLanguage = () => 'hr',
    getCityId = () => null,
    playLine,
    updateLine,
    stopLine,
    random = Math.random,
    scripts = PEDESTRIAN_CONVERSATIONS,
}) {
    let active = null;
    let delay = nextConversationDelayS({ first: true, randomValue: random() });
    const choose = values => values[Math.min(values.length - 1, Math.floor(random() * values.length))];

    function finish(foundPair = false) {
        active = null; // Invalidate the callback before stopping its source.
        stopLine();
        delay = nextConversationDelayS({ foundPair, randomValue: random() });
    }

    return {
        tick(dt, listener) {
            const step = Math.max(0, Number(dt) || 0);
            if (!active) {
                if (!listener || step === 0) return;
                delay -= step;
                if (delay > 0) return;
                const availableScripts = pedestrianConversationsForCity(getCityId(), scripts);
                if (!availableScripts.length) {
                    delay = nextConversationDelayS({ foundPair: false, randomValue: random() });
                    return;
                }
                const candidates = getPairs().flatMap(pair => {
                    const members = getMembers(pair);
                    return conversationPairSpatial(members, listener, { starting: true })
                        ? [{ pair, members }] : [];
                });
                if (!candidates.length) {
                    delay = nextConversationDelayS({ foundPair: false, randomValue: random() });
                    return;
                }
                const { pair, members } = choose(candidates);
                active = {
                    pair, people: members.map(member => member.person),
                    script: choose(availableScripts), language: getLanguage(),
                    lineIndex: 0, pauseSeconds: 0, waitingForAudio: false, spatial: null,
                };
            }

            const state = active;
            const members = getPairs().includes(state.pair) ? getMembers(state.pair) : null;
            const spatial = conversationPairSpatial(members, listener);
            if (!spatial || members.some((member, i) => member.person !== state.people[i])
                || state.language !== getLanguage()
                || (state.script.cityId != null && state.script.cityId !== getCityId())) {
                finish(false);
                return;
            }
            const authoredLine = state.script.lines[state.lineIndex];
            if (!authoredLine) {
                finish(true);
                return;
            }
            state.spatial = spatial[authoredLine.speaker === 'B' ? 1 : 0];
            // This must happen even while the current clip is playing.
            if (state.waitingForAudio) {
                updateLine(state.spatial);
                return;
            }
            state.pauseSeconds -= step;
            if (step === 0 || state.pauseSeconds > 0) return;
            state.waitingForAudio = true;
            const played = playLine(pedestrianConversationLine(authoredLine, state.language), state.spatial, () => {
                if (active !== state) return;
                state.waitingForAudio = false;
                state.lineIndex += 1;
                state.pauseSeconds = 0.28 + random() * 0.34;
            });
            if (!played) finish(false);
        },
        stop: finish,
        removePair(pair) {
            if (active?.pair === pair) finish(false);
        },
        snapshot() {
            return active ? {
                scriptId: active.script.id,
                language: active.language,
                lineIndex: active.lineIndex,
                speaker: active.script.lines[active.lineIndex]?.speaker ?? null,
                waitingForAudio: active.waitingForAudio,
                ...active.spatial,
            } : null;
        },
    };
}
