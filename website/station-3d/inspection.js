// Public, lightweight helpers for source-data inspection tools.
// This entry intentionally excludes the world runtime so a checker can inspect
// provider records without loading a second copy of Station3D.

export { entityKeyForFeature, parseEntityKey } from './core/entity-key.js';
export { createEntitySelectionStore } from './core/entity-selection-store.js';
export { buildingEntityMetadata, roadEntityMetadata } from './core/entity-metadata.js';
export {
    alignedDecorTiles,
    DECOR_KINDS,
    dedupeEntityRecords,
    normalizeDecorPayload,
    normalizeStops,
    normalizeTrackCollection,
    normalizeWaterCollection,
} from './core/source-entity-data.js';
