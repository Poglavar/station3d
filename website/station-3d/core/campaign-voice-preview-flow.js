// Pure helpers for the campaign voice audition page: which take a line can
// play for a chosen voice, and how the spoken lines connect (what leads into
// a line and what it leads to), so the page can light up a conversation's
// flow around the line under the pointer. No DOM, testable in node.

// The take a line plays for `voiceId`: recorded by that voice, still matching
// the text, with a file. The campaign's active take wins; otherwise the newest.
// No voice, no take — the play button stays disabled until a recorded voice
// is chosen.
export function takeForVoice(line, voiceId) {
    if (!voiceId) return null;
    const usable = usableTakes(line).filter(take => take.voiceId === voiceId);
    if (usable.length === 0) return null;
    return usable.find(take => take.active) || usable[usable.length - 1];
}

// The take the line is heard in today: the campaign's active take, else the
// newest playable one. A line whose speaker has no cast voice (a crew toast
// recorded through a per-line pick) still has a voice to start from.
export function activeTake(line) {
    const usable = usableTakes(line);
    return usable.find(candidate => candidate.active) || usable[usable.length - 1] || null;
}

// Every voice that has a playable take for the line, so a voice picker can
// tell recorded voices from the rest.
export function playableVoiceIds(line) {
    return new Set(usableTakes(line).map(take => take.voiceId).filter(Boolean));
}

function usableTakes(line) {
    const takes = Array.isArray(line?.takes) ? line.takes : [];
    return takes.filter(take => take && take.file && take.stale !== true);
}

// Line id → { prev, next, alternatives } over the preview index's conversation
// graph. A beat leads to its responses (or its next beat), a response leads to
// the beat it names, a conditional variant stands in for its beat and shares
// its neighbours; film captions follow one another in order.
export function conversationFlow(index) {
    const flow = new Map();
    const entry = (id) => {
        if (!flow.has(id)) flow.set(id, { prev: new Set(), next: new Set(), alternatives: new Set() });
        return flow.get(id);
    };
    const link = (from, to) => {
        if (!from || !to || from === to) return;
        entry(from).next.add(to);
        entry(to).prev.add(from);
    };
    const beatLineId = (conversation, beatId) => `conversation.${conversation.id}.${beatId}`;
    for (const conversation of index?.conversations || []) {
        for (const beat of conversation.beats || []) {
            const lineId = beat.line?.id || beatLineId(conversation, beat.id);
            entry(lineId);
            for (const incoming of beat.incoming || []) {
                if (incoming.kind === 'response') link(`${beatLineId(conversation, incoming.beatId)}.${incoming.responseId}`, lineId);
                else if (incoming.kind === 'beat') link(beatLineId(conversation, incoming.beatId), lineId);
            }
            const responses = beat.responses || [];
            for (const response of responses) {
                const responseLineId = response.line?.id || `${lineId}.${response.id}`;
                link(lineId, responseLineId);
                if (response.nextBeatId) link(responseLineId, beatLineId(conversation, response.nextBeatId));
            }
            if (responses.length === 0 && beat.nextBeatId) link(lineId, beatLineId(conversation, beat.nextBeatId));
        }
    }
    // Variants after every link exists, so they inherit the complete picture.
    for (const conversation of index?.conversations || []) {
        for (const beat of conversation.beats || []) {
            const lineId = beat.line?.id || beatLineId(conversation, beat.id);
            const base = entry(lineId);
            for (const variant of beat.variants || []) {
                if (!variant?.id) continue;
                const alternative = entry(variant.id);
                for (const id of base.prev) alternative.prev.add(id);
                for (const id of base.next) alternative.next.add(id);
                alternative.alternatives.add(lineId);
                base.alternatives.add(variant.id);
            }
        }
    }
    for (const cinematic of index?.cinematics || []) {
        const ids = (cinematic.captions || []).map((caption, position) => caption?.id || `cinematic.${cinematic.id}.${position}`);
        ids.forEach((id, position) => {
            entry(id);
            if (position > 0) link(ids[position - 1], id);
        });
    }
    return flow;
}
