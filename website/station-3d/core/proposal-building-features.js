// Converts the proposals layer's ingested buildings into GeoJSON features the
// ordinary buildings pipeline can eat, grouped into synthetic tiles. Pure —
// no THREE, no DOM — so the id namespace, the tiling and the exemption
// predicate are provable under node.
//
// Why synthetic tiles: buildings.js batches meshes into REGIONAL aggregate
// buckets keyed by overtureRegionForScope(tileKey). A non-numeric key is its
// own region, so `proposal|cx|cz` keys keep proposal geometry in buckets of
// their own — never merged into a cadastre region's bucket, which is what lets
// a display toggle hide solid proposal buildings without touching the city's.
// The cell size mirrors the cadastre's aggregate regions (tile × region span),
// so culling granularity matches the city's own buildings.
//
// Why the flag: a proposed building SUBSTITUTES for the cadastre building on
// its plot, which it does by standing inside its own footprint mask. The mask
// tests in buildings.js would therefore eat the proposal itself; features
// carrying __proposalBuilding are exempt from that mask, from the server
// carves, and from planner-track demolition (a plan-authoring overlap must not
// render as a demolished ruin).

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';

export const PROPOSAL_BUILDING_ID_PREFIX = 'proposal-building:';
export const PROPOSAL_BUILDING_TILE_PREFIX = 'proposal|';

export function isProposalBuildingFeature(feature) {
    return feature?.properties?.__proposalBuilding === true;
}

// Renderer-side test on the object_id alone: material/style caches key by id,
// not by feature, so the new-build architectural styling branches on this.
export function isProposalBuildingObjectId(objectId) {
    return typeof objectId === 'string' && objectId.startsWith(PROPOSAL_BUILDING_ID_PREFIX);
}

export function isProposalBuildingTileKey(tileKey) {
    return typeof tileKey === 'string' && tileKey.startsWith(PROPOSAL_BUILDING_TILE_PREFIX);
}

// Aggregate bucket keys end in `/<region>`, and for proposal tiles the region
// IS the tile key (non-numeric scopes are their own region).
export function isProposalBuildingBucketKey(bucketKey) {
    const key = String(bucketKey ?? '');
    return isProposalBuildingTileKey(key.slice(key.lastIndexOf('/') + 1));
}

function finiteRing(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const out = [];
    for (const pt of ring) {
        const lon = Number(pt && pt[0]);
        const lat = Number(pt && pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        out.push([lon, lat]);
    }
    // Distinct-point check: a ring of one repeated coordinate is not a footprint.
    const [lon0, lat0] = out[0];
    if (!out.some(([lon, lat]) => lon !== lon0 || lat !== lat0)) return null;
    return out;
}

function ringCentroid(ring) {
    // GeoJSON rings close on their first point; averaging the duplicate would
    // bias the centroid toward that corner (~40 m on a 200 m block) and could
    // tip a building into the neighbouring cell.
    const last = ring.length - 1;
    const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
    const n = closed ? last : ring.length;
    let lon = 0, lat = 0;
    for (let i = 0; i < n; i++) { lon += ring[i][0]; lat += ring[i][1]; }
    return { lon: lon / n, lat: lat / n };
}

/**
 * activeBuildings entries → Map<tileKey, Feature[]>.
 *
 * Entries with a modelUrl are SKIPPED: an uploaded glTF is the bespoke look and
 * stays on the proposals layer's own model path. Degenerate outer rings skip
 * the building; degenerate holes are dropped individually.
 */
export function proposalBuildingFeaturesByTile(buildings, {
    anchorLat,
    anchorLon,
    tileSizeM = 200,
} = {}) {
    const byTile = new Map();
    if (!Array.isArray(buildings)
        || !Number.isFinite(anchorLat) || !Number.isFinite(anchorLon)
        || !(tileSizeM > 0)) {
        return byTile;
    }
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    buildings.forEach((building, index) => {
        if (!building || building.modelUrl) return;
        const outer = finiteRing(building.ring);
        if (!outer) return;
        const holes = [];
        for (const hole of Array.isArray(building.holes) ? building.holes : []) {
            const ring = finiteRing(hole);
            if (ring) holes.push(ring);
        }
        const courtyardRings = [];
        for (const courtyard of Array.isArray(building.courtyardRings) ? building.courtyardRings : []) {
            const ring = finiteRing(courtyard);
            if (ring) courtyardRings.push(ring);
        }
        const heightRaw = Number(building.heightM);
        const height = Math.max(1, Number.isFinite(heightRaw) ? heightRaw : 6);
        const centroid = ringCentroid(outer);
        // Local scene metres, same frame the renderer uses (x east, z south).
        const x = (centroid.lon - anchorLon) * scaleLon;
        const z = -(centroid.lat - anchorLat) * scaleLat;
        const tileKey = `${PROPOSAL_BUILDING_TILE_PREFIX}${Math.floor(x / tileSizeM)}|${Math.floor(z / tileSizeM)}`;
        const feature = {
            type: 'Feature',
            properties: {
                object_id: `${PROPOSAL_BUILDING_ID_PREFIX}${index}`,
                height,
                __proposalBuilding: true,
                ...(building.proposalId != null ? { proposalId: building.proposalId } : {}),
                ...(courtyardRings.length ? { __proposalCourtyardRings: courtyardRings } : {}),
            },
            geometry: { type: 'Polygon', coordinates: [outer, ...holes] },
        };
        let list = byTile.get(tileKey);
        if (!list) { list = []; byTile.set(tileKey, list); }
        list.push(feature);
    });
    return byTile;
}
