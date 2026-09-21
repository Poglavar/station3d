// Separates the free-roam hostile SANDBOX from authored campaign combat.
//
// Both used to ride one `cabState.gameMode === 'game'` flag, and the campaign
// chase turns that flag on so the player can shoot back. The side effect was
// that starting the chase also switched on the whole free-roam hostile world —
// 42 machine-gun nests, randomly spawned enemy cars, capture flags and enemy
// trams — which then destroyed the required story vehicle in about sixteen
// seconds and failed the chapter. Authored pursuers still spawn and still fire;
// only the world's own hostile population is held back.

// A campaign session is never a sandbox either: drawing the story's sidearm
// must not populate the city with nests and enemy cars.
export function ambientHostilesEnabled({ gameMode, campaignEncounterActive, campaignSession = false } = {}) {
    return gameMode === 'game' && !campaignEncounterActive && !campaignSession;
}
