// Which control hint belongs to the thing the player is currently controlling.
// Pure so the mapping is unit-testable: the hint used to exist only as a toast
// fired once on entry, which is exactly when a player is least able to read it.

const CONTROLLER_HINT_KEYS = Object.freeze({
    aircraft: 'gta.enteredAirplane',
    boat: 'gta.enteredBoat',
    road: 'gta.enteredCar',
    rail: 'gta.tramEntered',
    foot: 'gta.controlsHint',
});

export function controlsHintKeyFor(controllerId, { railDoors = false, enterable = true, parachute = false, train = false } = {}) {
    const key = String(controllerId || '').trim();
    // Under a canopy the walker's keys steer the descent, not a stroll.
    if (key === 'foot' && parachute) return 'walk.parachuteHint';
    if (key === 'rail' && railDoors) return 'rail.controlsHint';
    // A flagged-down train is driven from its own cab, with a horn, not a bell.
    if (key === 'rail' && train) return 'gta.trainEntered';
    if (key === 'foot' && !enterable) return 'walk.controlsHint';
    return CONTROLLER_HINT_KEYS[key] || CONTROLLER_HINT_KEYS.foot;
}

// Walking and vehicle sessions both keep their current control list available.
export function controlsHintAvailableFor(sessionPresetId) {
    return ['gta', 'walk'].includes(String(sessionPresetId || '').trim().toLowerCase());
}

// Generic vehicle coaching that only free roam should show. Inside a campaign
// the objective card is the instruction, and a boat HUD line reading "move
// alongside the quay" while the objective says "sail out of the harbour" made
// the player choose which one to trust (Vis, 2026-09-09 audit). Actionable
// prompts stay: an exit that exists, a berth the scene authored, a vehicle
// ready to board.
const CAMPAIGN_SUPPRESSED_BOAT_HINTS = new Set(['gta.boatMoveCloserPrompt', 'gta.stopToExitPrompt']);

export function vehicleInteractionKeyForSession(key, { inCampaign = false, vehicleKind = '' } = {}) {
    const value = String(key || '');
    if (!inCampaign) return value;
    if (vehicleKind === 'boat' && CAMPAIGN_SUPPRESSED_BOAT_HINTS.has(value)) return '';
    return value;
}
