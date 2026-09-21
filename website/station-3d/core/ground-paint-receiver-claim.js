// The same physical surface eligibility governs material binding and queries
// used to place retained detail on a ground-paint receiver.
import { surfacePolicy, SURFACE_CLASS, SURFACE_VERTICAL_RELATION } from './surface-hierarchy.js';

const MAX_RECEIVER_RANK = surfacePolicy(SURFACE_CLASS.CONSTRUCTION).rank;

export function groundPaintReceiverAcceptsClaim(receiver, claim) {
    return groundPaintReceiverMinimumRank(receiver, claim) !== null;
}

export function groundPaintReceiverMinimumRank(receiver, claim) {
    if (!receiver || claim?.verticalBand !== receiver.verticalBand
        || claim?.verticalRelation !== SURFACE_VERTICAL_RELATION.SAME_LEVEL
        || claim?.capabilities?.color !== true) return null;
    // Ordinary earthwork is a continuation of terrain. Its structural role has
    // no colour precedence rank; that must not leave pale collar wedges inside
    // a parking/road paint footprint. Keep its physical class and support rules.
    // The shader restricts this binding to upward faces; retaining walls and
    // grade-separated structures retain their own materials.
    if (claim.surfaceClass === SURFACE_CLASS.ROAD_EARTHWORK) return 0;
    return Number.isFinite(claim.rank) && claim.rank >= 0 && claim.rank <= MAX_RECEIVER_RANK
        ? claim.rank : null;
}

export function groundPaintReceiverMaterialPolicy(receiver, claim) {
    const minimumRank = groundPaintReceiverMinimumRank(receiver, claim);
    if (minimumRank !== null) return { minimumRank, maximumRank: 255 };
    // Rail earthwork already carried mapped land use through the retired
    // terrain mask. Preserve that colouring without painting road materials
    // over ballast, or admitting it as a parking-detail support receiver.
    if (claim?.surfaceClass === SURFACE_CLASS.RAIL_EARTHWORK && claim.capabilities?.color
        && claim.verticalBand === receiver?.verticalBand
        && claim.verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL) {
        return { minimumRank: 0, maximumRank: surfacePolicy(SURFACE_CLASS.PASSIVE_LANDUSE).rank };
    }
    return null;
}

export function groundPaintReceiverAcceptsPaint(receiver, claim, record) {
    const policy = groundPaintReceiverMaterialPolicy(receiver, claim);
    return !!policy && record?.claim?.rank >= policy.minimumRank && record.claim.rank <= policy.maximumRank;
}
