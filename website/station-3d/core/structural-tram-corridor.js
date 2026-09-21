// Canonicalizes separately mapped structural tram ways into one carried
// double-track corridor and provides the matching bridge-envelope/walk support.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';

const DEFAULT_PAIR_GRID_M = 16;
const DEFAULT_ENVELOPE_GRID_M = 64;
const MIN_PAIR_CENTER_M = 1.8;
const MAX_PAIR_CENTER_M = 4.8;
const MAX_PAIR_HEIGHT_DELTA_M = 0.6;
const MAX_PAIR_LONGITUDINAL_SKEW_M = 1.25;
const MIN_PAIR_PARALLEL_DOT = Math.cos(15 * Math.PI / 180);
const ROAD_CARRIED_TRAM_MAX_LATERAL_M = 18;
const ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT = Math.cos(35 * Math.PI / 180);
export const STRUCTURAL_TRAM_EDGE_MARGIN_M = 0.5;

function propertiesOf(value) {
    return value?.feature?.properties || value?.properties || {};
}

function featureValue(value, key) {
    const properties = propertiesOf(value);
    return properties[key] ?? properties.tags?.[key] ?? null;
}

function affirmativeOsmValue(value) {
    if (value === true || value === 1) return true;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'yes'
        || normalized === 'true'
        || normalized === '1';
}

export function isStructuralOsmTramFeature(value) {
    const railway = String(
        featureValue(value, 'railway_type')
        ?? featureValue(value, 'railway')
        ?? '',
    ).trim().toLowerCase();
    if (railway !== 'tram') return false;
    const source = String(featureValue(value, 'source') ?? '').trim().toLowerCase();
    if (source && source !== 'osm') return false;
    const layer = finiteOrNull(featureValue(value, 'layer'));
    return affirmativeOsmValue(featureValue(value, 'bridge'))
        || affirmativeOsmValue(featureValue(value, 'embankment'))
        || (layer != null && layer > 0);
}

function featureIdentity(value) {
    const properties = propertiesOf(value);
    return String(
        properties.osmId
        ?? properties.osm_id
        ?? properties.trackId
        ?? properties.lineId
        ?? value?.sortKey
        ?? '',
    );
}

function featureIdentities(value) {
    const properties = propertiesOf(value);
    const identities = [
        properties.osmId,
        properties.osm_id,
        properties.trackId,
        ...(Array.isArray(properties.pairedSourceOsmIds)
            ? properties.pairedSourceOsmIds
            : []),
    ];
    return [...new Set(identities
        .filter(identity => identity != null && String(identity).length > 0)
        .map(String))];
}

function isSingleTrackSegment(segment) {
    return isStructuralOsmTramFeature(segment)
        && (segment?.startTrackCenterOffsetsM?.length ?? 1) === 1
        && (segment?.endTrackCenterOffsetsM?.length ?? 1) === 1;
}

function segmentDirection(segment) {
    const dx = Number(segment?.x2) - Number(segment?.x1);
    const dz = Number(segment?.z2) - Number(segment?.z1);
    const length = Math.hypot(dx, dz);
    return length > 1e-6 ? { ux: dx / length, uz: dz / length } : null;
}

function projectPoint(segment, x, z) {
    const dx = Number(segment.x2) - Number(segment.x1);
    const dz = Number(segment.z2) - Number(segment.z1);
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= 1e-9) return null;
    const t = Math.max(0, Math.min(
        1,
        ((x - segment.x1) * dx + (z - segment.z1) * dz) / lengthSq,
    ));
    const qx = segment.x1 + dx * t;
    const qz = segment.z1 + dz * t;
    return {
        x: qx,
        y: Number(segment.yStart)
            + (Number(segment.yEnd) - Number(segment.yStart)) * t,
        z: qz,
        t,
        distanceM: Math.hypot(x - qx, z - qz),
    };
}

function cellsForBounds(bounds, cellM) {
    const keys = [];
    const minX = Math.floor(bounds.minX / cellM);
    const maxX = Math.floor(bounds.maxX / cellM);
    const minZ = Math.floor(bounds.minZ / cellM);
    const maxZ = Math.floor(bounds.maxZ / cellM);
    for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) keys.push(`${x}:${z}`);
    }
    return keys;
}

function addToGrid(cells, item, bounds, cellM) {
    for (const key of cellsForBounds(bounds, cellM)) {
        const list = cells.get(key) || [];
        list.push(item);
        cells.set(key, list);
    }
}

function candidatesAt(cells, x, z, cellM) {
    return cells.get(`${Math.floor(x / cellM)}:${Math.floor(z / cellM)}`) || [];
}

function buildPairGrid(segments, cellM) {
    const cells = new Map();
    for (const segment of segments) {
        if (!isSingleTrackSegment(segment)) continue;
        addToGrid(cells, segment, {
            minX: Math.min(segment.x1, segment.x2) - MAX_PAIR_CENTER_M,
            maxX: Math.max(segment.x1, segment.x2) + MAX_PAIR_CENTER_M,
            minZ: Math.min(segment.z1, segment.z2) - MAX_PAIR_CENTER_M,
            maxZ: Math.max(segment.z1, segment.z2) + MAX_PAIR_CENTER_M,
        }, cellM);
    }
    return cells;
}

function relationAt(segment, candidate, x, z) {
    const ownDirection = segmentDirection(segment);
    const candidateDirection = segmentDirection(candidate);
    if (!ownDirection || !candidateDirection) return null;
    if (Math.abs(
        ownDirection.ux * candidateDirection.ux
        + ownDirection.uz * candidateDirection.uz
    ) < MIN_PAIR_PARALLEL_DOT) return null;
    const projected = projectPoint(candidate, x, z);
    if (!projected
        || projected.distanceM < MIN_PAIR_CENTER_M
        || projected.distanceM > MAX_PAIR_CENTER_M) return null;
    const ownProjected = projectPoint(segment, x, z);
    if (!ownProjected
        || Math.abs(projected.y - ownProjected.y) > MAX_PAIR_HEIGHT_DELTA_M) return null;
    const acrossX = projected.x - x;
    const acrossZ = projected.z - z;
    const longitudinalSkewM = Math.abs(
        acrossX * ownDirection.ux + acrossZ * ownDirection.uz
    );
    if (longitudinalSkewM > MAX_PAIR_LONGITUDINAL_SKEW_M) return null;
    const side = Math.sign(ownDirection.ux * acrossZ - ownDirection.uz * acrossX);
    return side === 0 ? null : { ...projected, side };
}

function nearestCompanion(cells, segment, x, z, cellM, expectedIdentity = null) {
    const ownIdentity = featureIdentity(segment);
    let best = null;
    for (const candidate of candidatesAt(cells, x, z, cellM)) {
        if (candidate === segment) continue;
        const candidateIdentity = featureIdentity(candidate);
        if (!candidateIdentity || candidateIdentity === ownIdentity) continue;
        if (expectedIdentity != null && candidateIdentity !== expectedIdentity) continue;
        const relation = relationAt(segment, candidate, x, z);
        if (!relation || (best && relation.distanceM >= best.distanceM)) continue;
        best = { ...relation, candidate, candidateIdentity };
    }
    return best;
}

function trackbedHalfWidthAt(segment, t) {
    const startM = Math.max(0, Number(segment?.startTrackbedHalfWidthM) || 0);
    const endM = Math.max(0, Number(segment?.endTrackbedHalfWidthM) || 0);
    const clampedT = Math.max(0, Math.min(1, Number(t) || 0));
    return startM + (endM - startM) * clampedT;
}

function pairedRelation(cells, segment, cellM, targetCenterSpacingM) {
    if (!isSingleTrackSegment(segment)) return null;
    const ownIdentity = featureIdentity(segment);
    if (!ownIdentity) return null;
    const middle = nearestCompanion(
        cells,
        segment,
        (segment.x1 + segment.x2) * 0.5,
        (segment.z1 + segment.z2) * 0.5,
        cellM,
    );
    if (!middle || !isSingleTrackSegment(middle.candidate)) return null;
    const start = nearestCompanion(
        cells,
        segment,
        segment.x1,
        segment.z1,
        cellM,
        middle.candidateIdentity,
    );
    const end = nearestCompanion(
        cells,
        segment,
        segment.x2,
        segment.z2,
        cellM,
        middle.candidateIdentity,
    );
    if (!start || !end || start.side !== middle.side || end.side !== middle.side) {
        return null;
    }
    const targetM = typeof targetCenterSpacingM === 'function'
        ? Number(targetCenterSpacingM(segment))
        : Number(targetCenterSpacingM);
    if (!(targetM >= MIN_PAIR_CENTER_M && targetM <= MAX_PAIR_CENTER_M)) return null;
    const candidateGaugeM = Number(middle.candidate?.gaugeM);
    const ownGaugeM = Number(segment?.gaugeM);
    if (Number.isFinite(candidateGaugeM)
        && Number.isFinite(ownGaugeM)
        && Math.abs(candidateGaugeM - ownGaugeM) > 0.05) return null;
    return {
        ownIdentity,
        companionIdentity: middle.candidateIdentity,
        middle,
        start,
        end,
        targetM,
    };
}

function corridorFeature(segment, relation, cache) {
    const identities = [relation.ownIdentity, relation.companionIdentity].sort();
    const pairKey = identities.join('+');
    if (cache.has(pairKey)) return cache.get(pairKey);
    const source = segment?.feature || {};
    const properties = propertiesOf(segment);
    const feature = {
        ...source,
        properties: {
            ...properties,
            tags: { ...(properties.tags || {}) },
            trackCount: 2,
            trackArrangement: 'together',
            structuralTramCorridor: true,
            pairedSourceOsmIds: identities,
        },
    };
    cache.set(pairKey, feature);
    return feature;
}

function combinedCorridorSegment(segment, relation, featureCache) {
    const x1 = (Number(segment.x1) + relation.start.x) * 0.5;
    const z1 = (Number(segment.z1) + relation.start.z) * 0.5;
    const x2 = (Number(segment.x2) + relation.end.x) * 0.5;
    const z2 = (Number(segment.z2) + relation.end.z) * 0.5;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) return null;
    const px = dz / len;
    const pz = -dx / len;
    const halfSpacingM = relation.targetM * 0.5;
    const startSingleHalfWidthM = Math.max(
        trackbedHalfWidthAt(segment, 0),
        trackbedHalfWidthAt(relation.start.candidate, relation.start.t),
    );
    const endSingleHalfWidthM = Math.max(
        trackbedHalfWidthAt(segment, 1),
        trackbedHalfWidthAt(relation.end.candidate, relation.end.t),
    );
    const yStart = (Number(segment.yStart) + relation.start.y) * 0.5;
    const yEnd = (Number(segment.yEnd) + relation.end.y) * 0.5;
    const feature = corridorFeature(segment, relation, featureCache);
    return {
        ...segment,
        cx: (x1 + x2) * 0.5,
        cz: (z1 + z2) * 0.5,
        len,
        x1,
        z1,
        x2,
        z2,
        yStart,
        yEnd,
        feature,
        properties: feature.properties,
        angle: Math.atan2(dx, dz),
        px,
        pz,
        startJoinX: px,
        startJoinZ: pz,
        endJoinX: px,
        endJoinZ: pz,
        startTrackCenterOffsetsM: [-halfSpacingM, halfSpacingM],
        endTrackCenterOffsetsM: [-halfSpacingM, halfSpacingM],
        startTrackbedHalfWidthM: halfSpacingM + startSingleHalfWidthM,
        endTrackbedHalfWidthM: halfSpacingM + endSingleHalfWidthM,
        startTrackbedInnerEdgeM: 0,
        endTrackbedInnerEdgeM: 0,
        relativeYStart: (
            Number(segment.relativeYStart) || 0
        ),
        relativeYEnd: (
            Number(segment.relativeYEnd) || 0
        ),
        structuralTramCorridor: true,
        pairedSourceOsmIds: feature.properties.pairedSourceOsmIds,
        sortKey: `${segment.sortKey || relation.ownIdentity}#corridor`,
    };
}

// OSM maps each running direction on bridges such as Most mladosti as its own
// LineString. Downstream renderers already understand one two-track corridor,
// so canonicalize the structural pair here instead of adding a separate infill
// mesh and a second collision representation later in the pipeline.
export function canonicalizeStructuralTramCorridors(segments, {
    cellM = DEFAULT_PAIR_GRID_M,
    targetCenterSpacingM = 2.8,
} = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const structuralSingles = list.filter(isSingleTrackSegment);
    if (structuralSingles.length < 2) return list;
    const cells = buildPairGrid(structuralSingles, cellM);
    const relations = new Map();
    for (const segment of structuralSingles) {
        const relation = pairedRelation(cells, segment, cellM, targetCenterSpacingM);
        if (relation) relations.set(segment, relation);
    }
    const featureCache = new Map();
    const result = [];
    for (const segment of list) {
        const relation = relations.get(segment);
        if (!relation) {
            result.push(segment);
            continue;
        }
        if (relation.ownIdentity.localeCompare(relation.companionIdentity) > 0) continue;
        result.push(combinedCorridorSegment(segment, relation, featureCache) || segment);
    }
    return result;
}

function endpointJoin(segment, endpoint) {
    const prefix = endpoint === 'start' ? 'start' : 'end';
    const x = Number(segment?.[`${prefix}JoinX`]);
    const z = Number(segment?.[`${prefix}JoinZ`]);
    if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) > 1e-6) {
        return { x, z };
    }
    const direction = segmentDirection(segment);
    return direction ? { x: direction.uz, z: -direction.ux } : { x: 1, z: 0 };
}

// One full-width analytic surface per carried tram chord. Ordinary surface
// trams continue to use road/terrain support; only bridges and their structural
// seams need a separate floor where the world below may be air.
function railTrackbedSurfaceQuad(segment, surfaceYOffsetM, structuralOnly) {
    if (structuralOnly && !isStructuralOsmTramFeature(segment)) return null;
    const startHalf = Number(segment?.startTrackbedHalfWidthM);
    const endHalf = Number(segment?.endTrackbedHalfWidthM);
    if (!(startHalf > 0) || !(endHalf > 0)) return null;
    const startJoin = endpointJoin(segment, 'start');
    const endJoin = endpointJoin(segment, 'end');
    return {
        osmIds: featureIdentities(segment),
        a: {
            x: segment.x1 - startJoin.x * startHalf,
            y: segment.yStart + surfaceYOffsetM,
            z: segment.z1 - startJoin.z * startHalf,
        },
        b: {
            x: segment.x2 - endJoin.x * endHalf,
            y: segment.yEnd + surfaceYOffsetM,
            z: segment.z2 - endJoin.z * endHalf,
        },
        c: {
            x: segment.x2 + endJoin.x * endHalf,
            y: segment.yEnd + surfaceYOffsetM,
            z: segment.z2 + endJoin.z * endHalf,
        },
        d: {
            x: segment.x1 + startJoin.x * startHalf,
            y: segment.yStart + surfaceYOffsetM,
            z: segment.z1 + startJoin.z * startHalf,
        },
    };
}

export function railTrackbedSurfaceQuads(
    segments,
    { surfaceYOffsetM = 0, structuralOnly = false } = {},
) {
    const quads = [];
    for (const segment of segments || []) {
        const quad = railTrackbedSurfaceQuad(segment, surfaceYOffsetM, structuralOnly);
        if (quad) quads.push(quad);
    }
    return quads;
}

export function structuralTramTrackbedSurfaceQuads(segments, options = {}) {
    return railTrackbedSurfaceQuads(segments, {
        ...options,
        structuralOnly: true,
    });
}

function triangleHeightAt(x, z, a, b, c) {
    const denominator = (b.z - c.z) * (a.x - c.x)
        + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) <= 1e-9) return null;
    const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
    const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
    const wc = 1 - wa - wb;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) return null;
    return a.y * wa + b.y * wb + c.y * wc;
}

function addTrackbedQuadToSupportGrid(cells, quad, cellM) {
    addToGrid(cells, quad, {
        minX: Math.min(quad.a.x, quad.b.x, quad.c.x, quad.d.x),
        maxX: Math.max(quad.a.x, quad.b.x, quad.c.x, quad.d.x),
        minZ: Math.min(quad.a.z, quad.b.z, quad.c.z, quad.d.z),
        maxZ: Math.max(quad.a.z, quad.b.z, quad.c.z, quad.d.z),
    }, cellM);
}

function trackbedSupportIndexFromGrid(cells, size, cellM) {
    return {
        supportYAtLocal(x, z, { osmId = null } = {}) {
            const localX = Number(x);
            const localZ = Number(z);
            const requiredOsmId = osmId == null ? null : String(osmId);
            let best = null;
            for (const quad of candidatesAt(cells, localX, localZ, cellM)) {
                if (requiredOsmId != null
                    && !quad.osmIds?.includes(requiredOsmId)) continue;
                const first = triangleHeightAt(localX, localZ, quad.a, quad.b, quad.c);
                const second = first == null
                    ? triangleHeightAt(localX, localZ, quad.a, quad.c, quad.d)
                    : null;
                const y = first ?? second;
                if (Number.isFinite(y) && (best == null || y > best)) best = y;
            }
            return best;
        },
        size,
    };
}

export function createStructuralTramTrackbedSupportIndex(
    quads,
    { cellM = DEFAULT_PAIR_GRID_M } = {},
) {
    const list = Array.isArray(quads) ? quads : [];
    const cells = new Map();
    for (const quad of list) addTrackbedQuadToSupportGrid(cells, quad, cellM);
    return trackbedSupportIndexFromGrid(cells, list.length, cellM);
}

// Rebuilds the same analytic floor directly from solved rail segments, one
// chord at a time. Callers retain their previous immutable index until this
// iterator returns, so a streamed height refresh never creates a collision gap.
export function* buildRailTrackbedSupportIndexResumable(
    segments,
    {
        cellM = DEFAULT_PAIR_GRID_M,
        surfaceYOffsetM = 0,
        structuralOnly = false,
    } = {},
) {
    const cells = new Map();
    let size = 0;
    for (const segment of segments || []) {
        const quad = railTrackbedSurfaceQuad(segment, surfaceYOffsetM, structuralOnly);
        if (quad) {
            addTrackbedQuadToSupportGrid(cells, quad, cellM);
            size += 1;
        }
        yield;
    }
    return trackbedSupportIndexFromGrid(cells, size, cellM);
}

function localFeatureSegments(features, anchorLat, anchorLon, halfWidthForFeature) {
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * DEG_TO_RAD);
    const segments = [];
    for (const feature of features || []) {
        if (!isStructuralOsmTramFeature(feature)
            || feature?.geometry?.type !== 'LineString') continue;
        const coordinates = feature.geometry.coordinates || [];
        const halfWidthM = Math.max(0, Number(halfWidthForFeature?.(feature)) || 0);
        for (let index = 0; index + 1 < coordinates.length; index++) {
            const from = coordinates[index];
            const to = coordinates[index + 1];
            const x1 = (Number(from?.[0]) - anchorLon) * metresPerDegreeLon;
            const z1 = -(Number(from?.[1]) - anchorLat) * metresPerDegreeLat;
            const x2 = (Number(to?.[0]) - anchorLon) * metresPerDegreeLon;
            const z2 = -(Number(to?.[1]) - anchorLat) * metresPerDegreeLat;
            if (![x1, z1, x2, z2].every(Number.isFinite)
                || Math.hypot(x2 - x1, z2 - z1) <= 1e-6) continue;
            segments.push({
                x1,
                yStart: 0,
                z1,
                x2,
                yEnd: 0,
                z2,
                halfWidthM,
                feature,
            });
        }
    }
    return segments;
}

// Road bridge generation asks this index for the outer edge of every nearby
// longitudinal structural tram. The deck/support/fence envelope therefore
// contains the tram reservation even though OSM maps roads and rails separately.
export function createStructuralTramCorridorEnvelopeIndex(features, {
    anchorLat = 0,
    anchorLon = 0,
    cellM = DEFAULT_ENVELOPE_GRID_M,
    halfWidthForFeature = () => 1.05,
} = {}) {
    const segments = localFeatureSegments(
        features,
        Number(anchorLat) || 0,
        Number(anchorLon) || 0,
        halfWidthForFeature,
    );
    const cells = new Map();
    for (const segment of segments) {
        addToGrid(cells, segment, {
            minX: Math.min(segment.x1, segment.x2) - ROAD_CARRIED_TRAM_MAX_LATERAL_M,
            maxX: Math.max(segment.x1, segment.x2) + ROAD_CARRIED_TRAM_MAX_LATERAL_M,
            minZ: Math.min(segment.z1, segment.z2) - ROAD_CARRIED_TRAM_MAX_LATERAL_M,
            maxZ: Math.max(segment.z1, segment.z2) + ROAD_CARRIED_TRAM_MAX_LATERAL_M,
        }, cellM);
    }
    return {
        formationOffsetsAtLocal(x, z, direction, {
            leftM = 0,
            rightM = 0,
            edgeMarginM = STRUCTURAL_TRAM_EDGE_MARGIN_M,
            maxLateralM = ROAD_CARRIED_TRAM_MAX_LATERAL_M,
            minDirectionDot = ROAD_CARRIED_TRAM_MIN_DIRECTION_DOT,
        } = {}) {
            const localX = Number(x);
            const localZ = Number(z);
            const dx = Number(direction?.x);
            const dz = Number(direction?.z);
            const directionLengthM = Math.hypot(dx, dz);
            const offsets = {
                leftM: Math.max(0, Number(leftM) || 0),
                rightM: Math.max(0, Number(rightM) || 0),
            };
            if (!Number.isFinite(localX) || !Number.isFinite(localZ)
                || directionLengthM <= 1e-6) return offsets;
            const ux = dx / directionLengthM;
            const uz = dz / directionLengthM;
            const normalX = -uz;
            const normalZ = ux;
            const radiusM = Math.max(0, Number(maxLateralM) || 0);
            const parallelMin = Math.max(0, Math.min(1, Number(minDirectionDot) || 0));
            for (const segment of candidatesAt(cells, localX, localZ, cellM)) {
                const candidateDirection = segmentDirection(segment);
                if (!candidateDirection || Math.abs(
                    ux * candidateDirection.ux + uz * candidateDirection.uz
                ) < parallelMin) continue;
                const projected = projectPoint(segment, localX, localZ);
                if (!projected || projected.distanceM > radiusM) continue;
                const signedOffsetM = (
                    (projected.x - localX) * normalX
                    + (projected.z - localZ) * normalZ
                );
                const outerOffsetM = Math.abs(signedOffsetM)
                    + segment.halfWidthM
                    + Math.max(0, Number(edgeMarginM) || 0);
                if (signedOffsetM >= 0) {
                    offsets.leftM = Math.max(offsets.leftM, outerOffsetM);
                } else {
                    offsets.rightM = Math.max(offsets.rightM, outerOffsetM);
                }
            }
            return offsets;
        },
        size: segments.length,
    };
}
