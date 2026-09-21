// Pure look-at policy shared by authored actors. Seated activities may keep
// their ambient pose, but an active dialogue always owns their attention.
export function campaignActorTracksPlayer({
    dialogueFocused = false,
    lookAtPlayer,
    activityType = '',
} = {}) {
    if (dialogueFocused) return true;
    if (lookAtPlayer === true) return true;
    if (lookAtPlayer === false) return false;
    return activityType !== 'fishing';
}
