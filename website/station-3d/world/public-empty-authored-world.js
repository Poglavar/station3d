// Empty authored-world adapter used by the public engine build until a separate content package is registered.
const emptyLayer = Object.freeze({
    beginSession() {},
    onFrame() {},
    // Empty authored adapters still participate in the shared ground-layer
    // contract. They are ready immediately and accept coordinator ownership;
    // omitting these methods made the extracted package fail only in-browser
    // when the first coordinated ground snapshot inspected every layer.
    groundReady() { return true; },
    manageGroundPublications() {},
    endSession() {},
});

export const campaignEnvironmentLayer = emptyLayer;
export const gricTunnelLandmarkLayer = emptyLayer;
export const campaignFireworksLayer = emptyLayer;
export const campaignMusicLayer = emptyLayer;
export const campaignTowerLayer = emptyLayer;

export function getCampaignEnvironmentSnapshot() { return null; }
export function restoreCampaignEnvironmentSnapshot() { return false; }
export function getCampaignEnvironmentGroup() { return null; }
export function getCampaignEnvironmentFloorY() { return null; }
export function getCampaignEnvironmentGroundYAt() { return null; }
export function replaceCampaignEnvironmentScene() { return true; }
export function syncCampaignEnvironmentCinematic() { return false; }
export function campaignEnvironmentFilmAircraft() { return null; }
export function campaignEnvironmentStandInVehicleKinds() { return []; }
export function campaignEnvironmentStandsInForPlayer() { return false; }
export function createSoftParticleTexture() { return null; }
export function getGricTunnelLandmarkGroup() { return null; }
export function campaignTowerRoofYAt() { return null; }
export function getCampaignTowerGroup() { return null; }
export function startCampaignFootPursuit() { return null; }
export function stopCampaignFootPursuit() {}
export function stepCampaignFootPursuit() { return null; }
export function getCampaignFootPursuitSnapshot() { return null; }
