// One proposal carries two related but different building shapes:
//   geometry.buildings    parcel-clipped pieces used for ownership/economics
//   geometry.blockMassing the authored block-wide envelope, including courts
//
// New records provide blockMassing directly. Older published records predate
// that field, so this schema-boundary helper unions their pieces once and
// recovers any enclosed holes. Rendering code never needs to know which path
// supplied the design geometry.

export const LEGACY_BLOCK_SEAM_CLOSE_M = 0.02;
const LEGACY_BLOCK_MAX_AREA_CHANGE_M2 = 1;

function geometryOf(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'Feature') return value.geometry || null;
    return value.geometry && !value.coordinates ? value.geometry : value;
}

function polygonFeature(value) {
    const geometry = geometryOf(value);
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return null;
    return { type: 'Feature', properties: {}, geometry };
}

function buildingPieces(proposal) {
    if (Array.isArray(proposal?.geometry?.buildings)) {
        return proposal.geometry.buildings.map(polygonFeature).filter(Boolean);
    }
    if (Array.isArray(proposal?.buildingProposal?.buildings)) {
        return proposal.buildingProposal.buildings
            .map(entry => polygonFeature(entry?.feature || entry))
            .filter(Boolean);
    }
    return [];
}

function holeCount(feature) {
    const geometry = geometryOf(feature);
    const polygons = geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : (geometry?.type === 'MultiPolygon' ? geometry.coordinates : []);
    return polygons.reduce((sum, rings) => (
        sum + (Array.isArray(rings) ? Math.max(0, rings.length - 1) : 0)
    ), 0);
}

function isBlockProposal(proposal) {
    const typology = proposal?.typologyType
        || proposal?.buildingProposal?.typologyType
        || proposal?.buildingProposal?.parameters?.typology
        || proposal?.geometry?.buildings?.[0]?.properties?.urbanRule?.typology;
    return String(typology || '').toLowerCase() === 'block';
}

function unionLegacyPieces(pieces, proposal, geometryOps) {
    if (!geometryOps || typeof geometryOps.union !== 'function') return null;
    let merged;
    try {
        merged = geometryOps.union(pieces) || null;
    } catch {
        return null;
    }
    if (!merged || holeCount(merged) > 0 || !isBlockProposal(proposal)
        || typeof geometryOps.buffer !== 'function' || typeof geometryOps.area !== 'function') {
        return merged;
    }

    // Old parcel-clipped blocks can carry a microscopic slit between pieces. Topologically that
    // turns an enclosed courtyard into part of the outer ring, even though the rendered walls meet.
    // Close only a measured 2 cm seam and accept it only when it creates a real hole while changing
    // at most 1 m². This is a legacy schema repair, not a general courtyard guess.
    try {
        const expanded = geometryOps.buffer(merged, LEGACY_BLOCK_SEAM_CLOSE_M);
        const closed = expanded ? geometryOps.buffer(expanded, -LEGACY_BLOCK_SEAM_CLOSE_M) : null;
        if (!closed || holeCount(closed) === 0) return merged;
        const areaChange = Math.abs(Number(geometryOps.area(closed)) - Number(geometryOps.area(merged)));
        return Number.isFinite(areaChange) && areaChange <= LEGACY_BLOCK_MAX_AREA_CHANGE_M2
            ? closed
            : merged;
    } catch {
        return merged;
    }
}

export function proposalBlockMassing(proposal, geometryOps = null) {
    const authored = polygonFeature(proposal?.geometry?.blockMassing);
    if (authored) return authored;

    const pieces = buildingPieces(proposal);
    if (pieces.length < 2) return pieces[0] || null;
    return unionLegacyPieces(pieces, proposal, geometryOps);
}

export function proposalCourtyardRings(proposal, geometryOps = null) {
    const geometry = proposalBlockMassing(proposal, geometryOps)?.geometry;
    if (!geometry) return [];
    const polygons = geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : (geometry.type === 'MultiPolygon' ? geometry.coordinates : []);
    const holes = [];
    for (const rings of polygons) {
        if (!Array.isArray(rings)) continue;
        for (let index = 1; index < rings.length; index += 1) {
            if (Array.isArray(rings[index]) && rings[index].length >= 4) holes.push(rings[index]);
        }
    }
    return holes;
}
