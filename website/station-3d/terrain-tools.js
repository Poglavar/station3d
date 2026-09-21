// Optional terrain-inspection helpers for developer tools and data-audit
// applications. This entry stays separate from the interactive world runtime:
// importing it does not create a renderer, load Three.js, or open a session.

export { fetchTerrainGridApi } from './core/terrain-api-grid.js';
export { TerrainGrid } from './core/terrain-grid.js';
export {
    buildTerrainViewerMeshData,
    parseTerrainViewerSettings,
    terrainColorAtHeight,
    terrainColorAtSource,
    terrainThresholdSliderModel,
    terrainViewerLocationAtLocal,
} from './core/terrain-viewer-model.js';
export {
    parseTerrainViewerElevationMode,
    parseTerrainViewerSource,
    TERRAIN_VIEWER_ELEVATION_MODES,
    TERRAIN_VIEWER_SOURCES,
    terrainViewerGridRequest,
} from './core/terrain-viewer-sources.js';
export {
    buildDrapeUvs,
    drapeBoundsFromMesh,
    osmDrapePlan,
    osmTileUrl,
} from './core/osm-drape.js';
export {
    DRAPE_RAIL_CLASSES,
    DRAPE_ROAD_CLASSES,
    RAIL_TEXTURE_TILE_M,
    buildDrapedBuilding,
    buildDrapedRibbon,
    clipChainToRect,
    drapeClipRectFromView,
    drapeFetchBboxes,
    railDrapeStyle,
    roadDrapeStyle,
    roadHighwayValuesForClasses,
    terrainDrapeLayerPolicy,
} from './core/terrain-drape-layers.js';
