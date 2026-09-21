import { finiteOrNull, geoToLocal } from '../core/math.js';
import { getTrackbedHalfWidthMeters } from './tram-trackbed-dimensions.js';

export const TRACK_CORRIDOR_CENTER_Y_M = 2.5;
export const TRACK_CORRIDOR_HALF_HEIGHT_M = 2.5;
export const ELEVATED_EMERGENCY_WALKWAY_WIDTH_M = 2.0;
export const ELEVATED_WALKWAY_CURB_WIDTH_M = 0.22;
export const ELEVATED_GUIDEWAY_DECK_THICKNESS_M = 0.7;
export const ELEVATED_GUIDEWAY_RIGHT_EXTENSION_M =
    ELEVATED_WALKWAY_CURB_WIDTH_M + ELEVATED_EMERGENCY_WALKWAY_WIDTH_M;
// Open -1 ramps expose the whole trench, including both retaining walls, not
// merely the paved track strip in its centre.
export const PLANNER_OPEN_CUT_HALF_WIDTH_M = 4.2;

const DEFAULT_HALF_WIDTH_PADDING_M = 1.05;
const DEFAULT_END_PAD_M = 1.0;
const DEFAULT_MIN_SEGMENT_LENGTH_M = 0.75;
const DEFAULT_ELEVATED_THRESHOLD_M = 0.5;

function collectLineStrings(features) {
    const lines = [];
    for (const feature of features || []) {
        const geom = feature && feature.geometry;
        if (!geom) continue;
        if (geom.type === 'LineString') {
            lines.push({ coordinates: geom.coordinates || [], feature });
        } else if (geom.type === 'MultiLineString') {
            for (const line of geom.coordinates || []) {
                lines.push({ coordinates: line || [], feature });
            }
        }
    }
    return lines;
}

// A track's third coordinate means "metres above the local ground" ONLY in the
// relative regime. An absolute/asl datum puts a sea-level height there instead,
// and reading one as a level is not a small error: the Sibenik 141 bore sits
// 2.44 m above the Adriatic under 14.5 m of rock, which read as a deck 2.44 m
// over the street — so an "elevated" band was cut from just above the ground to
// the sky along the whole bore and every building above it lost its walls.
// The same misreading culls the trees beside it and lifts its curbs.
//
// This is the ONE place that knows which regime a feature is in, so no consumer
// has to remember: outside the relative regime the levels are handed out as
// null, and a null level classifies as nothing at all.
export function hasRelativeElevations(properties) {
    return properties?.elevationMode !== 'absolute'
        && properties?.elevationDatum !== 'asl';
}

function appendUniqueCoordinate(target, lng, lat, elev) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const last = target[target.length - 1];
    if (last && Math.abs(last[0] - lng) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) return;
    // A 2D coordinate has no level, which is not the same fact as "level 0" —
    // that conflation makes a line with no authored profile read as a track
    // lying at grade. Keep it absent and let each rule decline to classify.
    target.push([lng, lat, finiteOrNull(elev)]);
}

export function buildTrackCorridorVolumes(features, anchorLat, anchorLon, options = {}) {
    const fixedHalfWidth = Number.isFinite(options.halfWidth) ? options.halfWidth : null;
    const halfWidthPadding = Number.isFinite(options.halfWidthPadding)
        ? options.halfWidthPadding
        : DEFAULT_HALF_WIDTH_PADDING_M;
    const halfHeight = Number.isFinite(options.halfHeight) ? options.halfHeight : TRACK_CORRIDOR_HALF_HEIGHT_M;
    const centerY = Number.isFinite(options.centerY) ? options.centerY : TRACK_CORRIDOR_CENTER_Y_M;
    const endPad = Number.isFinite(options.endPad) ? options.endPad : DEFAULT_END_PAD_M;
    const elevatedRightExtension = Number.isFinite(options.elevatedRightExtension)
        ? Math.max(0, options.elevatedRightExtension)
        : ELEVATED_GUIDEWAY_RIGHT_EXTENSION_M;
    const elevatedThreshold = Number.isFinite(options.elevatedThreshold)
        ? options.elevatedThreshold
        : DEFAULT_ELEVATED_THRESHOLD_M;
    const minSegmentLength = Number.isFinite(options.minSegmentLength)
        ? options.minSegmentLength
        : DEFAULT_MIN_SEGMENT_LENGTH_M;
    const segmentFilter = typeof options.segmentFilter === 'function'
        ? options.segmentFilter
        : null;
    const volumes = [];

    for (const entry of collectLineStrings(features)) {
        const rawLine = entry.coordinates;
        const feature = entry.feature;
        const properties = feature?.properties || {};
        const baseHalfWidth = fixedHalfWidth ?? (
            getTrackbedHalfWidthMeters(properties) + halfWidthPadding
        );
        // Absolute/asl third coordinates are sea-level heights, not levels above
        // the ground, so this feature has no levels to hand out at all.
        const relativeLevels = hasRelativeElevations(properties);
        const coords = [];
        for (const coord of rawLine || []) {
            if (!Array.isArray(coord) || coord.length < 2) continue;
            appendUniqueCoordinate(coords, Number(coord[0]), Number(coord[1]), Number(coord[2]));
        }
        for (let i = 0; i < coords.length - 1; i++) {
            const [lonA, latA, rawElevA] = coords[i];
            const [lonB, latB, rawElevB] = coords[i + 1];
            const elevA = relativeLevels ? rawElevA : null;
            const elevB = relativeLevels ? rawElevB : null;
            const hasLevels = elevA !== null && elevB !== null;
            if (segmentFilter && !segmentFilter({
                feature,
                properties,
                segmentIndex: i,
                coordinateA: coords[i],
                coordinateB: coords[i + 1],
                startElevationM: elevA,
                endElevationM: elevB,
            })) continue;
            const start = geoToLocal(lonA, latA, anchorLon, anchorLat);
            const end = geoToLocal(lonB, latB, anchorLon, anchorLat);
            const dx = end.x - start.x;
            const dz = end.z - start.z;
            const len = Math.hypot(dx, dz);
            if (len < minSegmentLength) continue;
            const alongX = dx / len;
            const alongZ = dz / len;
            const rightX = -alongZ;
            const rightZ = alongX;
            // Positive-level tracks carry an inner curb plus a 2 m emergency
            // walkway on their right. Represent the asymmetric footprint as a
            // shifted OBB while keeping the original left track edge fixed.
            // With no level to read there is no elevated deck to widen for.
            const rightExtension = hasLevels && Math.max(elevA, elevB) > elevatedThreshold
                ? elevatedRightExtension
                : 0;
            const centerRightShift = rightExtension * 0.5;
            volumes.push({
                centerX: (start.x + end.x) * 0.5 + rightX * centerRightShift,
                // Elevated/underground segments carry the corridor with them.
                // An unknown level cannot lift it — the caller's plane stands.
                centerY: centerY + (hasLevels ? (elevA + elevB) * 0.5 : 0),
                centerZ: (start.z + end.z) * 0.5 + rightZ * centerRightShift,
                alongX,
                alongZ,
                rightX,
                rightZ,
                halfWidth: baseHalfWidth + centerRightShift,
                halfHeight,
                halfDepth: len * 0.5 + endPad,
                segmentHalfLength: len * 0.5,
                startElevationM: elevA,
                endElevationM: elevB,
                ownerTrackId: properties.trackId ?? null,
                ownerTrackIds: Array.isArray(properties.trackIds)
                    ? properties.trackIds.map(String)
                    : [],
                source: properties.source ?? null,
            });
        }
    }

    return volumes;
}

// Cars cannot use the space below the beginning/end of a +1 ramp until the
// underside of its deck provides the requested free height. Return clipped
// footprint OBBs for only that low-clearance portion of each rising/falling
// segment, rather than blocking the useful space beneath the whole viaduct.
export function buildLowElevatedRampVolumes(features, anchorLat, anchorLon, options = {}) {
    const fixedHalfWidth = Number.isFinite(options.halfWidth) ? options.halfWidth : null;
    const halfWidthPadding = Number.isFinite(options.halfWidthPadding)
        ? options.halfWidthPadding
        : DEFAULT_HALF_WIDTH_PADDING_M;
    const rightExtension = Number.isFinite(options.rightExtension)
        ? Math.max(0, options.rightExtension)
        : ELEVATED_GUIDEWAY_RIGHT_EXTENSION_M;
    const deckThicknessM = Number.isFinite(options.deckThicknessM)
        ? Math.max(0, options.deckThicknessM)
        : 0.7;
    const freeHeightM = Number.isFinite(options.freeHeightM)
        ? Math.max(0, options.freeHeightM)
        : 3;
    const maxTrackElevationM = deckThicknessM + freeHeightM;
    const endPad = Number.isFinite(options.endPad) ? options.endPad : 0.4;
    const volumes = [];

    for (const entry of collectLineStrings(features)) {
        const rawLine = entry.coordinates;
        const properties = entry.feature?.properties || {};
        // Same rule as buildTrackCorridorVolumes: a sea-level height is not a
        // deck height, so an absolute alignment has no ramp to clear under.
        if (!hasRelativeElevations(properties)) continue;
        const baseHalfWidth = fixedHalfWidth ?? (
            getTrackbedHalfWidthMeters(properties) + halfWidthPadding
        );
        for (let i = 0; i < rawLine.length - 1; i++) {
            const a = rawLine[i];
            const b = rawLine[i + 1];
            if (!Array.isArray(a) || !Array.isArray(b)) continue;
            const lonA = Number(a[0]);
            const latA = Number(a[1]);
            const lonB = Number(b[0]);
            const latB = Number(b[1]);
            if (![lonA, latA, lonB, latB].every(Number.isFinite)) continue;
            // An absent level reads as 0 through Number(), which here is the
            // ground — so a 2D line grew a ramp rising out of nothing.
            const eA = finiteOrNull(a[2]);
            const eB = finiteOrNull(b[2]);
            if (eA === null || eB === null) continue;
            const delta = eB - eA;
            if (Math.abs(delta) <= 0.01 || Math.max(eA, eB) <= 0) continue;
            const crossingA = (0 - eA) / delta;
            const crossingB = (maxTrackElevationM - eA) / delta;
            const tStart = Math.max(0, Math.min(1, Math.min(crossingA, crossingB)));
            const tEnd = Math.max(0, Math.min(1, Math.max(crossingA, crossingB)));
            if (tEnd - tStart <= 1e-4) continue;

            const startRaw = geoToLocal(lonA, latA, anchorLon, anchorLat);
            const endRaw = geoToLocal(lonB, latB, anchorLon, anchorLat);
            const start = {
                x: startRaw.x + (endRaw.x - startRaw.x) * tStart,
                z: startRaw.z + (endRaw.z - startRaw.z) * tStart,
            };
            const end = {
                x: startRaw.x + (endRaw.x - startRaw.x) * tEnd,
                z: startRaw.z + (endRaw.z - startRaw.z) * tEnd,
            };
            const dx = end.x - start.x;
            const dz = end.z - start.z;
            const len = Math.hypot(dx, dz);
            if (len < 0.25) continue;
            const alongX = dx / len;
            const alongZ = dz / len;
            const rightX = -alongZ;
            const rightZ = alongX;
            const centerRightShift = rightExtension * 0.5;
            const clippedEA = eA + delta * tStart;
            const clippedEB = eA + delta * tEnd;
            volumes.push({
                centerX: (start.x + end.x) * 0.5 + rightX * centerRightShift,
                centerY: (clippedEA + clippedEB) * 0.5,
                centerZ: (start.z + end.z) * 0.5 + rightZ * centerRightShift,
                alongX,
                alongZ,
                rightX,
                rightZ,
                halfWidth: baseHalfWidth + centerRightShift,
                halfHeight: maxTrackElevationM * 0.5 + 0.5,
                halfDepth: len * 0.5 + endPad,
                segmentHalfLength: len * 0.5,
                startElevationM: clippedEA,
                endElevationM: clippedEB,
                ownerTrackId: properties.trackId ?? null,
                ownerTrackIds: Array.isArray(properties.trackIds)
                    ? properties.trackIds.map(String)
                    : [],
                source: 'planner-low-elevated-ramp',
            });
        }
    }
    return volumes;
}

// ── What a segment's levels say about it ───────────────────────────────────
//
// Every one of these answers FALSE when either level is unknown. That is the
// whole point: `Number(null) || 0` said "level 0", which is a real and
// plausible reading — a track lying exactly at grade — so an absent level
// silently authorised the most destructive verdict these rules can reach.
// Unknown is not a level, and a rule that cannot see the track does not get to
// demolish what stands over it.
const SURFACE_LEVEL_TOLERANCE_M = 0.05;

function levelPair(startElevationM, endElevationM) {
    const start = finiteOrNull(startElevationM);
    const end = finiteOrNull(endElevationM);
    return start === null || end === null ? null : { start, end };
}

export function isPlannerUndergroundRampSegment(startElevationM, endElevationM) {
    const levels = levelPair(startElevationM, endElevationM);
    if (!levels) return false;
    return Math.min(levels.start, levels.end) < -0.01
        && Math.abs(levels.start - levels.end) > 0.01;
}

// At grade: the track lies on the street, so the works are open to the sky.
export function isPlannerSurfaceLevelSegment(startElevationM, endElevationM) {
    const levels = levelPair(startElevationM, endElevationM);
    if (!levels) return false;
    return Math.abs(levels.start) <= SURFACE_LEVEL_TOLERANCE_M
        && Math.abs(levels.end) <= SURFACE_LEVEL_TOLERANCE_M;
}

// On a deck: the structure rises clear of the ground it crosses.
export function isPlannerElevatedSegment(
    startElevationM,
    endElevationM,
    thresholdM = SURFACE_LEVEL_TOLERANCE_M,
) {
    const levels = levelPair(startElevationM, endElevationM);
    if (!levels) return false;
    return Math.max(levels.start, levels.end) > thresholdM;
}

export function isPlannerSurfaceOpenCutSegment(startElevationM, endElevationM) {
    return isPlannerSurfaceLevelSegment(startElevationM, endElevationM)
        || isPlannerUndergroundRampSegment(startElevationM, endElevationM);
}

// ── Spatial index over corridor volumes ────────────────────────────────────
//
// Both point tests below used to scan EVERY volume. A 50 km reconstruction is
// thousands of oriented boxes strung end to end, and every curb piece and road
// vertex ran the whole list: these two functions were 9.3% of a 60 s CPU profile
// of a corridor ride, and the largest single cost in it. A point can only be
// inside a box near it, so the scan is pure waste.
//
// The index is a uniform grid keyed on the volumes ARRAY itself, so callers keep
// passing the same argument and nothing downstream changes. It is built on first
// use and held weakly — a session that rebuilds its corridors gets a fresh array
// and the old grid is collected with it.
//
// The exact oriented-box test is unchanged and still decides every hit; the grid
// only narrows which boxes are asked.
const CORRIDOR_INDEX_CELL_M = 32;
// Below this a linear scan is cheaper than hashing a cell key.
const CORRIDOR_INDEX_MIN_VOLUMES = 24;
const corridorIndexCache = new WeakMap();

// World-axis half-extents of an oriented box: project both of its axes onto X
// and Z. This is why the grid can hold a rotated volume without rotating cells.
function volumeExtentX(volume) {
    return Math.abs(volume.rightX) * volume.halfWidth
        + Math.abs(volume.alongX) * volume.halfDepth;
}

function volumeExtentZ(volume) {
    return Math.abs(volume.rightZ) * volume.halfWidth
        + Math.abs(volume.alongZ) * volume.halfDepth;
}

function corridorIndexFor(volumes) {
    if (!Array.isArray(volumes) || volumes.length < CORRIDOR_INDEX_MIN_VOLUMES) return null;
    const cached = corridorIndexCache.get(volumes);
    if (cached) return cached;
    const cells = new Map();
    for (const volume of volumes) {
        if (!volume) continue;
        const ex = volumeExtentX(volume);
        const ez = volumeExtentZ(volume);
        const minCx = Math.floor((volume.centerX - ex) / CORRIDOR_INDEX_CELL_M);
        const maxCx = Math.floor((volume.centerX + ex) / CORRIDOR_INDEX_CELL_M);
        const minCz = Math.floor((volume.centerZ - ez) / CORRIDOR_INDEX_CELL_M);
        const maxCz = Math.floor((volume.centerZ + ez) / CORRIDOR_INDEX_CELL_M);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cz = minCz; cz <= maxCz; cz++) {
                const key = `${cx}:${cz}`;
                let bucket = cells.get(key);
                if (!bucket) { bucket = []; cells.set(key, bucket); }
                bucket.push(volume);
            }
        }
    }
    const index = { cells };
    corridorIndexCache.set(volumes, index);
    return index;
}

// Volumes worth testing for a point, optionally grown by a padding the caller
// will add to the box itself. Returns the original array when there is no index,
// so an un-indexed call is exactly the old behaviour.
function corridorCandidates(volumes, worldX, worldZ, padding = 0) {
    const index = corridorIndexFor(volumes);
    if (!index) return volumes || [];
    // Padding grows the box in its OWN rotated frame (halfWidth + r along
    // `right`, halfDepth + r along `along`), so in world X the box grows by
    // r*(|rightX| + |alongX|). Those axes are orthonormal, so that sum peaks at
    // sqrt(2) on a box at 45 degrees — expanding the query by r alone missed
    // volumes a cell away, which the exhaustive comparison caught at padding 6.
    const reach = padding * Math.SQRT2;
    const minCx = Math.floor((worldX - reach) / CORRIDOR_INDEX_CELL_M);
    const maxCx = Math.floor((worldX + reach) / CORRIDOR_INDEX_CELL_M);
    const minCz = Math.floor((worldZ - reach) / CORRIDOR_INDEX_CELL_M);
    const maxCz = Math.floor((worldZ + reach) / CORRIDOR_INDEX_CELL_M);
    if (minCx === maxCx && minCz === maxCz) {
        return index.cells.get(`${minCx}:${minCz}`) || EMPTY_CANDIDATES;
    }
    // A padded query can straddle cells; de-duplicate so a volume spanning
    // several of them is not tested twice.
    const seen = new Set();
    for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
            const bucket = index.cells.get(`${cx}:${cz}`);
            if (bucket) for (const volume of bucket) seen.add(volume);
        }
    }
    return seen;
}

const EMPTY_CANDIDATES = Object.freeze([]);

export function isPointInsideCorridorVolumes(worldX, worldY, worldZ, volumes) {
    for (const volume of corridorCandidates(volumes, worldX, worldZ)) {
        const dx = worldX - volume.centerX;
        const dy = worldY - volume.centerY;
        const dz = worldZ - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) <= volume.halfWidth &&
            Math.abs(dy) <= volume.halfHeight &&
            Math.abs(localAlong) <= volume.halfDepth) {
            return true;
        }
    }
    return false;
}

// Horizontal-only corridor test for ground furniture and other objects that
// must never overlap the trackbed. `padding` accounts for the object's own
// footprint (a bench centre can be outside the nominal corridor while its
// seat still hangs over a rail).
export function isPointInsideCorridorFootprints(worldX, worldZ, volumes, padding = 0) {
    const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
    // The padding grows the box, so the query has to look that far out too or a
    // volume one cell over would be missed.
    for (const volume of corridorCandidates(volumes, worldX, worldZ, safePadding)) {
        const dx = worldX - volume.centerX;
        const dz = worldZ - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) <= volume.halfWidth + safePadding &&
            Math.abs(localAlong) <= volume.halfDepth + safePadding) {
            return true;
        }
    }
    return false;
}

// Tests a real oriented footprint against the swept OBBs of a track corridor.
// A centre-point test is not enough for long vehicles: a parked van can have
// its centre clear of the rails while its nose still occupies a tram's swept
// path. The four separating axes below are the exact 2D OBB-vs-OBB test.
export function orientedFootprintIntersectsCorridors({
    centerX,
    centerZ,
    heading = 0,
    widthM,
    lengthM,
    clearanceM = 0,
    volumes,
} = {}) {
    const x = Number(centerX);
    const z = Number(centerZ);
    const yaw = Number(heading);
    const halfWidth = Number(widthM) * 0.5;
    const halfLength = Number(lengthM) * 0.5;
    const clearance = Number.isFinite(clearanceM) ? Math.max(0, clearanceM) : 0;
    if (![x, z, yaw, halfWidth, halfLength].every(Number.isFinite)
        || halfWidth <= 0 || halfLength <= 0) return false;

    const vehicleAlongX = Math.sin(yaw);
    const vehicleAlongZ = Math.cos(yaw);
    const vehicleRightX = vehicleAlongZ;
    const vehicleRightZ = -vehicleAlongX;
    const queryPadding = Math.hypot(halfWidth, halfLength) + clearance;

    for (const volume of corridorCandidates(volumes, x, z, queryPadding)) {
        if (!volume) continue;
        const dx = x - volume.centerX;
        const dz = z - volume.centerZ;
        const axes = [
            [volume.rightX, volume.rightZ],
            [volume.alongX, volume.alongZ],
            [vehicleRightX, vehicleRightZ],
            [vehicleAlongX, vehicleAlongZ],
        ];
        let separated = false;
        for (const [axisX, axisZ] of axes) {
            const centerDistance = Math.abs(dx * axisX + dz * axisZ);
            const corridorRadius = Math.abs(axisX * volume.rightX + axisZ * volume.rightZ)
                    * volume.halfWidth
                + Math.abs(axisX * volume.alongX + axisZ * volume.alongZ)
                    * volume.halfDepth;
            const vehicleRadius = Math.abs(axisX * vehicleRightX + axisZ * vehicleRightZ)
                    * halfWidth
                + Math.abs(axisX * vehicleAlongX + axisZ * vehicleAlongZ)
                    * halfLength;
            if (centerDistance > corridorRadius + vehicleRadius + clearance) {
                separated = true;
                break;
            }
        }
        if (!separated) return true;
    }
    return false;
}
