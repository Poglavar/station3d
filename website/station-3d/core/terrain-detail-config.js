// Which native-resolution terrain window a session composes over its base grid.
// The location config owns it for ordinary play. An offline campaign pack bake
// may bring its own, because a baked level pays the LiDAR cost once at authoring
// time, while a live city would pay it on every open — which is why Zagreb's
// location has no window and its baked level used to inherit 20 m ground.

export function resolveTerrainDetailConfig(terrainConfig, campaignTerrainDetail = null) {
    if (!terrainConfig || terrainConfig.metadataUrl) return null;
    if (terrainConfig.detail) return terrainConfig.detail;
    if (campaignTerrainDetail && typeof campaignTerrainDetail === 'object') return campaignTerrainDetail;
    return null;
}
