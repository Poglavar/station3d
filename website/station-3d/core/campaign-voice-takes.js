// The selected clip is also a take, including recordings made before history
// existed. File names are immutable take IDs shared by the editor and storage.
export function recordingTakes(manifest, lineId) {
    const entries = [...(manifest?.takes?.[lineId] || []), manifest?.clips?.[lineId]];
    return [...new Map(entries.filter(entry => entry?.file).map(entry => [entry.file, entry])).values()];
}

// The campaign text is the only text: a take recorded from other words can be
// kept as history but never selected to speak for the line, so what plays and
// what is displayed cannot drift apart. `lineHash` is the current text's hash.
export function selectRecordingTake(manifest, lineId, takeId, lineHash) {
    const takes = recordingTakes(manifest, lineId);
    const selected = takes.find(entry => entry.file === takeId);
    if (!selected || !lineHash || selected.hash !== lineHash) return null;
    manifest.takes ||= {};
    manifest.takes[lineId] = takes;
    manifest.clips[lineId] = selected;
    manifest.voiceOverrides = { ...manifest.voiceOverrides, [lineId]: {
        voiceId: selected.voiceId, voiceName: selected.voiceName,
    } };
    return selected;
}
