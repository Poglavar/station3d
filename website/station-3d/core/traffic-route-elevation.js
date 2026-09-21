// Route-owned vertical placement for road traffic. A graph edge may use a
// synthetic id for routing/retirement while its visible road is owned by a
// different RoadFormationModel id (proposal roads are the important case).

import { finiteOrNull } from './math.js';

export function trafficRouteFormationId(segment) {
    const scopedId = segment?.formationOsmId;
    if (scopedId != null && String(scopedId).trim()) return scopedId;
    return segment?.osmId ?? null;
}

export function trafficRouteBaseSceneYAtLocal({
    x,
    z,
    segment = null,
    roadFormation = null,
    terrainSceneY = null,
} = {}) {
    const ownerId = trafficRouteFormationId(segment);
    if (ownerId != null && typeof roadFormation?.formationAtLocal === 'function') {
        const owned = roadFormation.formationAtLocal(x, z, {
            osmId: ownerId,
            allowStale: true,
        });
        const routeY = finiteOrNull(owned?.roadY);
        if (routeY !== null) return routeY;
    }
    return finiteOrNull(terrainSceneY);
}
