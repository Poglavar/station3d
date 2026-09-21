// Pure campaign-train handoff rules shared by keyboard routing, snapshots,
// and the live cab-to-walk conversion. A door command is not an open door:
// the campaign may advance only after the animation exposes a safe opening.

import { finiteOrNull } from './math.js';

export const CAMPAIGN_RAIL_EXIT_DOOR_RATIO = 0.8;

export function campaignRailDoorState({ doors = null, status = null } = {}) {
    const liveRatio = finiteOrNull(doors?.ratio);
    const statusRatio = finiteOrNull(status?.doorRatio);
    const rawRatio = liveRatio
        ?? statusRatio
        ?? (status?.doorsOpen === true ? 1 : 0);
    const doorRatio = Math.max(0, Math.min(1, rawRatio));
    return {
        doorRatio,
        doorsOpen: doorRatio >= CAMPAIGN_RAIL_EXIT_DOOR_RATIO,
    };
}

export function shouldRouteRailDoorInteraction({
    isTrainSession = false,
    walkMode = false,
    controllerId = '',
} = {}) {
    return isTrainSession === true && !walkMode && controllerId === 'rail';
}

export function campaignRailHandoffReady({
    isTrainSession = false,
    walkMode = false,
    controllerId = '',
    gtaReady = false,
    speedMps = Infinity,
    doorRatio = 0,
} = {}) {
    const speed = finiteOrNull(speedMps);
    const ratio = finiteOrNull(doorRatio);
    return shouldRouteRailDoorInteraction({ isTrainSession, walkMode, controllerId })
        && gtaReady === true
        && speed != null
        && Math.abs(speed) <= 0.15
        && ratio != null
        && ratio >= CAMPAIGN_RAIL_EXIT_DOOR_RATIO;
}
