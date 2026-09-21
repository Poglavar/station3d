// Resolves curb height from the curb polygon's explicit vertical owner before
// falling back to the general road-formation or terrain surfaces.

import { finiteOrNull } from './math.js';

export const CURB_OWNER_SEPARATION_M = 1;

function normalizedOsmIds(osmIds) {
    return Array.from(new Set(
        (Array.isArray(osmIds) ? osmIds : [osmIds])
            .filter(value => value != null)
            .map(value => String(value)),
    ));
}

// The curb endpoint groups emitted by /roads/curbs are already partitioned by
// their OSM vertical layer. A non-zero bridge/tunnel group therefore cannot
// contain the at-grade road below it, even when only some of its member ways
// have a client-side alignment. The expensive per-point owner-separation test
// is only needed for layer 0, where a manually synthesized alignment may lift
// an otherwise untagged road out of the server's planar union.
export function curbUnionNeedsSeparatedOwnerChecks({
    verticalLayer = 0,
    osmIds = null,
    verticalOsmIds = null,
} = {}) {
    const numericLayer = Number(verticalLayer);
    if (Number.isFinite(numericLayer) && numericLayer !== 0) return false;
    const ids = normalizedOsmIds(osmIds);
    const verticalIds = new Set(normalizedOsmIds(verticalOsmIds));
    return verticalIds.size > 0 && ids.some(osmId => !verticalIds.has(osmId));
}

export function resolveCurbOwnerAtLocal({
    x,
    z,
    osmIds = null,
    verticalOsmIds = null,
    roadVerticalAlignments = null,
    roadFormation = null,
    terrain = null,
    allowStaleRoadFormation = false,
} = {}) {
    // A server curb polygon can be an ST_Union of several roads which only
    // overlap in plan. Resolve the nearest source centreline before consulting
    // a vertical profile; the presence of one bridge-family ID must not lift
    // the lower road's entire union polygon onto the bridge.
    const formation = roadFormation?.formationAtLocal?.(x, z, {
        maxDistanceM: 15,
        osmIds,
        allowStale: allowStaleRoadFormation,
    });
    if (formation) {
        const ownerOsmId = formation.osmId == null
            ? null
            : String(formation.osmId);
        const ownerAlignment = ownerOsmId == null
            ? null
            : roadVerticalAlignments?.getAlignmentForOsmId?.(ownerOsmId);
        const alignmentY = ownerAlignment
            ? finiteOrNull(
                roadVerticalAlignments?.roadYAtLocal?.(
                    x,
                    z,
                    ownerOsmId,
                ),
            )
            : null;
        const sceneY = alignmentY ?? finiteOrNull(formation.roadY);
        if (sceneY != null) {
            const profileOwner = ownerOsmId == null
                ? null
                : roadVerticalAlignments?.getProfileOwnerForOsmId?.(ownerOsmId)
                    || ownerAlignment;
            return {
                osmId: ownerOsmId,
                profileOwnerId: profileOwner?.id || null,
                sceneY,
                vertical: !!ownerAlignment,
            };
        }
    }

    if (Array.isArray(verticalOsmIds) && verticalOsmIds.length > 0) {
        const verticalY = finiteOrNull(
            roadVerticalAlignments?.roadYForOsmIdsAtLocal?.(
                x,
                z,
                verticalOsmIds,
            ),
        );
        if (verticalY != null) {
            const firstVerticalId = String(verticalOsmIds[0]);
            const profileOwner = roadVerticalAlignments
                ?.getProfileOwnerForOsmId?.(firstVerticalId)
                || roadVerticalAlignments?.getAlignmentForOsmId?.(firstVerticalId);
            return {
                osmId: firstVerticalId,
                profileOwnerId: profileOwner?.id || null,
                sceneY: verticalY,
                vertical: true,
            };
        }
    }

    const formationY = finiteOrNull(roadFormation?.sceneYAtLocal?.(x, z, {
        maxDistanceM: 15,
        osmIds,
        allowStale: allowStaleRoadFormation,
    }));
    if (formationY != null) {
        return {
            osmId: null,
            profileOwnerId: null,
            sceneY: formationY,
            vertical: false,
        };
    }
    // Curbs are published geometry. The total visual terrain sampler may use
    // a fallback datum to cover void, but that fallback is not a curb height.
    if (!terrain) {
        return {
            osmId: null,
            profileOwnerId: null,
            sceneY: 0,
            vertical: false,
        };
    }
    const terrainY = finiteOrNull(terrain.evidenceSceneYAtLocal?.(x, z));
    return terrainY == null
        ? null
        : {
            osmId: null,
            profileOwnerId: null,
            sceneY: terrainY,
            vertical: false,
        };
}

export function resolveCurbSceneYAtLocal(options = {}) {
    return resolveCurbOwnerAtLocal(options)?.sceneY ?? null;
}

export function curbUnionHasSeparatedOwnersAtLocal({
    x,
    z,
    osmIds = null,
    verticalOsmIds = null,
    roadVerticalAlignments = null,
    roadFormation = null,
    maxOwnerDistanceM = 12,
    minimumSeparationM = CURB_OWNER_SEPARATION_M,
    allowStaleRoadFormation = false,
} = {}) {
    if (!roadFormation?.formationAtLocal
        || !roadVerticalAlignments?.getAlignmentForOsmId) {
        return false;
    }
    const ids = normalizedOsmIds(osmIds);
    if (ids.length < 2) return false;
    const explicitVerticalIds = normalizedOsmIds(verticalOsmIds);
    const verticalIds = explicitVerticalIds.length > 0
        ? explicitVerticalIds
        : ids.filter(osmId => roadVerticalAlignments.getAlignmentForOsmId(osmId));
    const verticalIdSet = new Set(verticalIds);
    const ordinaryIds = ids.filter(osmId => !verticalIdSet.has(osmId));
    if (verticalIds.length === 0 || ordinaryIds.length === 0) return false;
    const maximumDistanceSquared = Math.max(
        0,
        Number(maxOwnerDistanceM) || 0,
    ) ** 2;
    // Ask the indexed formation model for the nearest member of each owner
    // category once. The old per-OSM loop repeated a full nearest-profile query
    // for every member at every curb sample; a four-way union multiplied each
    // edge probe into four independent spatial searches even though only the
    // nearest aligned and nearest ordinary owners can own that curb point.
    const verticalFormation = roadFormation.formationAtLocal(x, z, {
        osmIds: verticalIds,
        allowStale: allowStaleRoadFormation,
    });
    const ordinaryFormation = roadFormation.formationAtLocal(x, z, {
        osmIds: ordinaryIds,
        allowStale: allowStaleRoadFormation,
    });
    const verticalDistanceSquared = Number(verticalFormation?.distanceSquared);
    const ordinaryDistanceSquared = Number(ordinaryFormation?.distanceSquared);
    if (!Number.isFinite(verticalDistanceSquared)
        || verticalDistanceSquared > maximumDistanceSquared
        || !Number.isFinite(ordinaryDistanceSquared)
        || ordinaryDistanceSquared > maximumDistanceSquared) {
        return false;
    }
    const verticalY = finiteOrNull(verticalFormation?.roadY);
    const ordinaryY = finiteOrNull(ordinaryFormation?.roadY);
    if (verticalY == null || ordinaryY == null) return false;
    return Math.abs(verticalY - ordinaryY) >= Math.max(
        0,
        Number(minimumSeparationM) || 0,
    );
}
