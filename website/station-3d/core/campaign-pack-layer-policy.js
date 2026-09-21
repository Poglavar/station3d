// Defines which live Station3D layers an immutable campaign world pack replaces.
// Authored layers that change during play must remain live above the baked world.

const CAMPAIGN_PACK_REPLACED_LAYER_NAMES = new Set([
    'terrain',
    'photoreal',
    'roads',
    'roadStructures',
    'curbs',
    'laneMarkings',
    'rails',
    'electrification',
    'levelCrossings',
    'plannerElevation',
    'proposals',
    'buildings',
    'farBuildings',
    'courtyardPassages',
    'undergroundStations',
    'platforms',
    'flags',
    'decor',
    'water',
    'sourceEntities',
    'streetLamps',
    'streetNames',
]);

export function campaignPackReplacesLayer(layerName) {
    return CAMPAIGN_PACK_REPLACED_LAYER_NAMES.has(String(layerName || ''));
}
