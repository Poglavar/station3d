// Read-only adapter between road crossing evidence (WGS84) and the canonical
// RailFormationModel (session-local scene coordinates). The road subsystem may
// sample this profile, but it must never mutate or re-solve rail geometry.

import { finiteOrNull } from './math.js';

export const DEFAULT_RAIL_CROSSING_QUERY_RADIUS_M = 12;

function sourceValue(properties, ...keys) {
    for (const key of keys) {
        const value = properties?.[key] ?? properties?.tags?.[key];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return null;
}

function alignmentMatchKind(alignment, composition = {}) {
    const properties = alignment?.feature?.properties || {};
    const requestedOsmId = composition.osmId == null
        ? null
        : String(composition.osmId);
    const alignmentOsmId = sourceValue(properties, 'osm_id', 'osmId');
    if (requestedOsmId && alignmentOsmId && requestedOsmId === alignmentOsmId) {
        return 'osm-id';
    }
    const requestedRef = composition.ref == null
        ? null
        : String(composition.ref).trim();
    const alignmentRef = sourceValue(properties, 'ref', 'legacyRef');
    if (requestedRef && alignmentRef && requestedRef === alignmentRef) {
        return 'rail-ref';
    }
    return null;
}

function isExistingRailAlignment(alignment) {
    const properties = alignment?.feature?.properties || {};
    const source = sourceValue(properties, 'source', 'alignmentSource');
    return source === 'legacy-rail'
        || sourceValue(properties, 'legacyRef', 'legacyProjectId') != null
        || sourceValue(properties, 'osm_id', 'osmId') != null;
}

function nearerFormation(current, candidate) {
    if (!candidate) return current;
    if (!current) return candidate;
    const currentDistanceSquared = finiteOrNull(current.distanceSquared) ?? Infinity;
    const candidateDistanceSquared = finiteOrNull(candidate.distanceSquared) ?? Infinity;
    return candidateDistanceSquared < currentDistanceSquared ? candidate : current;
}

export function sampleRailFormationElevationAslMAtCoordinate({
    railFormation,
    coordinate,
    anchorElevationAslM,
    composition = {},
    maxDistanceM = DEFAULT_RAIL_CROSSING_QUERY_RADIUS_M,
} = {}) {
    const lon = finiteOrNull(coordinate?.[0]);
    const lat = finiteOrNull(coordinate?.[1]);
    const anchorAslM = finiteOrNull(anchorElevationAslM);
    if (!railFormation?.formationAtLocal || lon == null || lat == null || anchorAslM == null) {
        return null;
    }
    const local = typeof railFormation.toLocal === 'function'
        ? railFormation.toLocal(lon, lat)
        : null;
    const x = finiteOrNull(local?.x);
    const z = finiteOrNull(local?.z);
    if (x == null || z == null) return null;

    let formation = null;
    let match = null;
    let hasIdentityMatch = false;
    const existingAlignments = (railFormation.alignments || [])
        .filter(isExistingRailAlignment);
    for (const alignment of existingAlignments) {
        const candidateMatch = alignmentMatchKind(alignment, composition);
        if (!candidateMatch || !alignment?.feature) continue;
        hasIdentityMatch = true;
        const candidate = railFormation.formationAtLocal(x, z, {
            feature: alignment.feature,
            maxDistanceM,
        });
        const selected = nearerFormation(formation, candidate);
        if (selected !== formation) {
            formation = selected;
            match = candidateMatch;
        }
    }
    // Once source identity resolves an alignment, a miss is genuine missing
    // route evidence. Falling through to another horizontally-near railway
    // would make a grade-separated junction adopt the wrong guideway height.
    if (!formation && !hasIdentityMatch) {
        for (const alignment of existingAlignments) {
            if (!alignment?.feature) continue;
            formation = nearerFormation(
                formation,
                railFormation.formationAtLocal(x, z, {
                    feature: alignment.feature,
                    maxDistanceM,
                }),
            );
        }
        match = formation ? 'nearest-route' : null;
    }
    const railSceneY = finiteOrNull(formation?.railY);
    if (railSceneY == null) return null;

    const distanceSquared = finiteOrNull(formation.distanceSquared);
    return {
        elevationAslM: anchorAslM + railSceneY,
        source: 'rail-formation',
        match,
        alignmentId: formation.alignment?.id ?? null,
        distanceM: distanceSquared == null ? null : Math.sqrt(Math.max(0, distanceSquared)),
        structure: formation.structure ?? null,
        authoredAbsolute: formation.alignment?.authoredAbsolute === true,
    };
}
