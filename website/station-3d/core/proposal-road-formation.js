// Adapter between authored consensus-builder road corridors and Station3D's
// single engineered-road authority. Proposal parks and paths are terrain
// fabric; proposal roads are not. Their centreline supplies longitudinal grade
// and their corridor polygon supplies the cut/fill ownership envelope.

export const PROPOSAL_ROAD_FORMATION_HIGHWAY = 'residential';

function safeIdPart(value, fallback) {
    const text = value == null ? '' : String(value).trim();
    return text || fallback;
}

export function proposalRoadFormationId(proposalId, segmentId, segmentIndex = 0) {
    return `proposal-road:${safeIdPart(proposalId, 'unknown')}`
        + `:${safeIdPart(segmentId, `segment-${segmentIndex + 1}`)}`
        + `:${Math.max(0, Number(segmentIndex) || 0)}`;
}

function lineCoordinates(line) {
    return (Array.isArray(line) ? line : []).map((point) => {
        const lon = Number(point && (point.lng ?? point.lon ?? point[0]));
        const lat = Number(point && (point.lat ?? point[1]));
        return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    }).filter(Boolean);
}

function closedRingCoordinates(ring) {
    const coordinates = (Array.isArray(ring) ? ring : []).map((point) => {
        const lon = Number(point && point[0]);
        const lat = Number(point && point[1]);
        return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    }).filter(Boolean);
    if (coordinates.length < 3) return [];
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        coordinates.push(first.slice());
    }
    return coordinates;
}

// RoadFormationModel deliberately consumes ordinary GeoJSON road features.
// Keeping this adapter pure lets tests prove that proposals enter exactly that
// same authority instead of growing a second, subtly different grade solver.
export function proposalRoadFormationFeatures(roads) {
    const centerlines = [];
    const surfaces = [];
    for (const road of Array.isArray(roads) ? roads : []) {
        if (road?.isTrack || road?.formationId == null) continue;
        const coordinates = lineCoordinates(road.line);
        const ring = closedRingCoordinates(road.ring);
        if (coordinates.length < 2 || ring.length < 4) continue;
        const osmId = String(road.formationId);
        const common = {
            osm_id: osmId,
            source: 'proposal',
            proposal_id: road.proposalId == null ? null : String(road.proposalId),
            proposal_segment_id: road.id == null ? null : String(road.id),
        };
        centerlines.push({
            type: 'Feature',
            properties: {
                ...common,
                highway: PROPOSAL_ROAD_FORMATION_HIGHWAY,
            },
            geometry: { type: 'LineString', coordinates },
        });
        surfaces.push({
            type: 'Feature',
            properties: {
                ...common,
                highway_type: PROPOSAL_ROAD_FORMATION_HIGHWAY,
                tags: {
                    highway: PROPOSAL_ROAD_FORMATION_HIGHWAY,
                    source: 'proposal',
                },
            },
            geometry: { type: 'Polygon', coordinates: [ring] },
        });
    }
    return { centerlines, surfaces };
}
