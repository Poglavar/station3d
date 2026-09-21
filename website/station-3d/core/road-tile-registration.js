// Cooperatively derives immutable per-tile road lookup metadata before publication.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';
import { roadSurfaceUsesEngineeredFormation } from './road-formation.js';
import { roadSurfaceAlignmentFeatureKey } from './road-surface-alignment-inputs.js';

const DEFAULT_WORK_UNITS_PER_STEP = 256;

function outerRingsFor(feature) {
    const geometry = feature?.geometry;
    if (geometry?.type === 'Polygon') {
        const ring = geometry.coordinates?.[0];
        return Array.isArray(ring) ? [ring] : [];
    }
    if (geometry?.type === 'MultiPolygon') {
        const rings = [];
        for (const polygon of geometry.coordinates || []) {
            const ring = polygon?.[0];
            if (Array.isArray(ring)) rings.push(ring);
        }
        return rings;
    }
    return [];
}

export function createRoadTileRegistrationTask(features, {
    anchorLat,
    anchorLon,
    pedestrianMinAreaM2,
    workUnitsPerStep = DEFAULT_WORK_UNITS_PER_STEP,
} = {}) {
    const safeFeatures = Array.isArray(features) ? features : [];
    const originLat = Number(anchorLat) || 0;
    const originLon = Number(anchorLon) || 0;
    const minAreaM2 = Math.max(0, Number(pedestrianMinAreaM2) || 0);
    const stepLimit = Math.max(1, Math.floor(Number(workUnitsPerStep) || 0));
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(originLat * DEG_TO_RAD);
    const engineeredOsmIds = new Set();
    const pedestrianEntries = [];
    const alignmentEntries = [];
    let featureIndex = 0;
    let pendingRings = [];
    let pendingRingIndex = 0;
    let pendingOsmId = null;
    let activeRing = null;
    let activePointIndex = 0;
    let activePoints = [];
    let activeAreaTwice = 0;
    let activeFirstPoint = null;
    let activePreviousPoint = null;
    let activeBounds = null;
    let done = false;

    function beginRing(ring) {
        activeRing = ring;
        activePointIndex = 0;
        activePoints = [];
        activeAreaTwice = 0;
        activeFirstPoint = null;
        activePreviousPoint = null;
        activeBounds = {
            minX: Infinity,
            maxX: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity,
        };
    }

    function appendCoordinate(coordinate) {
        const lon = Number(coordinate?.[0]);
        const lat = Number(coordinate?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const point = {
            x: (lon - originLon) * metresPerDegreeLon,
            z: -(lat - originLat) * metresPerDegreeLat,
        };
        if (!activeFirstPoint) activeFirstPoint = point;
        if (activePreviousPoint) {
            activeAreaTwice += activePreviousPoint.x * point.z
                - point.x * activePreviousPoint.z;
        }
        activePreviousPoint = point;
        activeBounds.minX = Math.min(activeBounds.minX, point.x);
        activeBounds.maxX = Math.max(activeBounds.maxX, point.x);
        activeBounds.minZ = Math.min(activeBounds.minZ, point.z);
        activeBounds.maxZ = Math.max(activeBounds.maxZ, point.z);
        activePoints.push(point);
    }

    function finishRing() {
        if (activeFirstPoint && activePreviousPoint) {
            activeAreaTwice += activePreviousPoint.x * activeFirstPoint.z
                - activeFirstPoint.x * activePreviousPoint.z;
        }
        if (activePoints.length > 1) {
            const first = activePoints[0];
            const last = activePoints[activePoints.length - 1];
            if (Math.abs(first.x - last.x) < 1e-6
                && Math.abs(first.z - last.z) < 1e-6) {
                activePoints.pop();
            }
        }
        if (activePoints.length >= 3 && Math.abs(activeAreaTwice / 2) >= minAreaM2) {
            pedestrianEntries.push({
                osmId: pendingOsmId,
                pts: activePoints,
                ...activeBounds,
            });
        }
        activeRing = null;
        activePoints = [];
        activeBounds = null;
    }

    function beginFeature(feature) {
        alignmentEntries.push([roadSurfaceAlignmentFeatureKey(feature), feature]);
        const properties = feature?.properties || {};
        const osmId = properties.osm_id;
        if (osmId != null && roadSurfaceUsesEngineeredFormation(feature)) {
            engineeredOsmIds.add(String(osmId));
        }
        if (properties.railway_type || properties.highway_type !== 'pedestrian') {
            pendingRings = [];
            return;
        }
        pendingOsmId = osmId;
        pendingRings = outerRingsFor(feature);
        pendingRingIndex = 0;
    }

    return {
        phaseLabel() {
            if (activeRing) {
                return `pedestrian registration ${activePointIndex}/${activeRing.length}`;
            }
            return `road registration ${featureIndex}/${safeFeatures.length}`;
        },

        step() {
            if (done) return 'done';
            let workUnits = 0;
            while (workUnits < stepLimit) {
                if (activeRing) {
                    if (activePointIndex < activeRing.length) {
                        appendCoordinate(activeRing[activePointIndex]);
                        activePointIndex += 1;
                        workUnits += 1;
                        continue;
                    }
                    finishRing();
                    continue;
                }
                if (pendingRingIndex < pendingRings.length) {
                    beginRing(pendingRings[pendingRingIndex]);
                    pendingRingIndex += 1;
                    continue;
                }
                pendingRings = [];
                if (featureIndex < safeFeatures.length) {
                    beginFeature(safeFeatures[featureIndex]);
                    featureIndex += 1;
                    workUnits += 1;
                    continue;
                }
                done = true;
                return 'done';
            }
            return 'more';
        },

        result() {
            if (!done) throw new Error('Road tile registration is not complete');
            return { engineeredOsmIds, pedestrianEntries, alignmentEntries };
        },
    };
}
