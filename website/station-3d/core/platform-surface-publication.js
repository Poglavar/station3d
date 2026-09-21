// Canonical surface/publication identity for one complete moving station window.
// The renderer supplies object facts; this pure module decides their hierarchy
// claims without importing THREE or owning any live scene state.

import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
} from './surface-hierarchy.js';

export const PLATFORM_SURFACE_PUBLICATION_KEY = 'platforms:stations';

function platformVerticalBand(stationLevel, surfaceCutStation, groundMarking) {
    if (groundMarking) return 'ground';
    if (surfaceCutStation) return 'open-cut';
    if (stationLevel < 0) return 'subsurface';
    if (stationLevel > 0) return 'elevated';
    return 'surface-structure';
}

export function platformSurfaceClaimInput({
    name = '',
    walkableSurface = false,
    stationLevel = 0,
    surfaceCutStation = false,
    stopId = null,
} = {}, generation) {
    const platformMarking = String(name) === 'StationPlatformMarking';
    const groundMarking = platformMarking
        && stationLevel === 0
        && !surfaceCutStation;
    const structuralSupport = !groundMarking && walkableSurface === true;
    return Object.freeze({
        surfaceClass: platformMarking ? SURFACE_CLASS.SIDEWALK : SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        // Only the thin, ordinary surface-stop marking competes in the flat
        // hierarchy. Slabs, stairs, lifts and canopies preserve every stacked
        // road/rail/pedestrian level and rely on their real geometry + depth.
        verticalRelation: groundMarking
            ? SURFACE_VERTICAL_RELATION.SAME_LEVEL
            : SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        verticalBand: platformVerticalBand(
            Number(stationLevel) || 0,
            surfaceCutStation === true,
            groundMarking,
        ),
        ownerId: 'platforms-stations',
        featureId: stopId == null ? null : String(stopId),
        sourceId: 'world/platforms.js',
        structureId: stopId == null ? 'station-access' : `station:${String(stopId)}`,
        replacementKey: PLATFORM_SURFACE_PUBLICATION_KEY,
        generation,
        supportReady: structuralSupport,
        // A walkable structural solid is a valid floor beneath an intentional
        // station opening. Paint and decorative volumes never grant that right.
        cutsBackstop: structuralSupport,
    });
}

export function platformOpeningClaimInput(generation) {
    return Object.freeze({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        verticalBand: 'station-access-opening',
        ownerId: 'platform-station-openings',
        sourceId: 'world/platforms.js',
        structureId: 'station-access',
        replacementKey: PLATFORM_SURFACE_PUBLICATION_KEY,
        generation,
        replacementBackstopReady: true,
        paintsColor: false,
        supportReady: true,
        cutsBackstop: true,
    });
}

export function platformSurfacePublicationCommitted(status) {
    return status === 'published'
        || status === 'published-with-retirement-error'
        || status === 'cleared'
        || status === 'cleared-with-retirement-error';
}
