// Geographic terrain and rail-support queries over immutable published
// triangles. Missing evidence stays unknown and never becomes sea level.
import { geoToLocal } from './math.js';
import { SURFACE_CLASS } from './surface-hierarchy.js';

const RAIL_SUPPORT_CLASSES = Object.freeze([SURFACE_CLASS.RAIL_TRACKBED]);
const GRADE_CHORD_M = 20;

export function createCampaignPackTerrainReference(support, { releaseId, anchorLon, anchorLat, sceneDatumAslM }) {
    const atGeo = (lon, lat) => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        const point = geoToLocal(lon, lat, anchorLon, anchorLat);
        return support.terrainYAt(point.x, point.z);
    };
    const reference = Object.freeze({
        contract: 'station3d-ground-read-snapshot-v1',
        bounded: true,
        revision: `campaign-pack:${releaseId}`,
        anchorLon,
        anchorLat,
        anchorHeightM: Number.isFinite(sceneDatumAslM) ? sceneDatumAslM : null,
        absoluteToSceneY: heightM => Number.isFinite(heightM) && Number.isFinite(sceneDatumAslM)
            ? heightM - sceneDatumAslM : null,
        captureReadSnapshot: () => reference,
        sceneYAtLocal: (x, z) => support.terrainYAt(x, z),
        evidenceSceneYAtLocal: (x, z) => support.terrainYAt(x, z),
        sceneYAt: atGeo,
        evidenceSceneYAt: atGeo,
        evidenceSlopeAlongHeadingDeg(lon, lat, headingDeg) {
            if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(headingDeg)) return null;
            const point = geoToLocal(lon, lat, anchorLon, anchorLat);
            const heading = headingDeg * Math.PI / 180;
            const dx = Math.sin(heading) * GRADE_CHORD_M / 2;
            const dz = -Math.cos(heading) * GRADE_CHORD_M / 2;
            const behind = support.terrainYAt(point.x - dx, point.z - dz);
            const ahead = support.terrainYAt(point.x + dx, point.z + dz);
            return Number.isFinite(behind) && Number.isFinite(ahead)
                ? Math.atan2(ahead - behind, GRADE_CHORD_M) * 180 / Math.PI : null;
        },
        onChange: () => () => {},
        renderedRailSurface: null,
    });
    return reference;
}

export function sampleCampaignPackRailSurface(support, x, z, {
    referenceY = null,
    headingDeg = 0,
    profilePitchDeg = null,
} = {}) {
    const query = { surfaceClasses: RAIL_SUPPORT_CLASSES, referenceY };
    const railY = support?.supportYAt?.(x, z, query);
    if (!Number.isFinite(railY)) return null;
    // The captured driving profile keeps its own signed grade at endpoints
    // and crossings, where a free spatial chord may hit another rail level.
    if (Number.isFinite(profilePitchDeg)) {
        return { railY, grade: Math.tan(profilePitchDeg * Math.PI / 180) };
    }
    // Use the existing spatial index and a measured chord. A miss at either
    // end withholds pitch only; support under the train remains authoritative.
    if (!Number.isFinite(headingDeg)) return { railY, grade: null };
    const heading = headingDeg * Math.PI / 180;
    const dx = Math.sin(heading) * GRADE_CHORD_M / 2;
    const dz = -Math.cos(heading) * GRADE_CHORD_M / 2;
    query.referenceY = railY;
    const behind = support.supportYAt(x - dx, z - dz, query);
    const ahead = support.supportYAt(x + dx, z + dz, query);
    return {
        railY,
        grade: Number.isFinite(behind) && Number.isFinite(ahead)
            ? (ahead - behind) / GRADE_CHORD_M : null,
    };
}
