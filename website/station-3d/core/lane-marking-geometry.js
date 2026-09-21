// Builds continuous lane-divider paths from OSM road centrelines, including
// width-aware spacing and tapered joins where the mapped lane count changes.

import { computeRibbonStations, densifyChain } from '../world/footpath-geometry.js';

// These two estimates intentionally match cadastre-data/roads/fetch-osm-roads.js,
// which creates the asphalt polygon consumed by Station3D.
export const DEFAULT_MOTOR_LANE_WIDTH_M = 3;
export const DEFAULT_ROAD_EDGE_ALLOWANCE_M = 0.5;
export const LANE_TRANSITION_LENGTH_M = 28;
export const JUNCTION_MARKING_SETBACK_M = 3;
export const JUNCTION_MARKING_MIN_CLEARANCE_M = 5;
export const JUNCTION_MARKING_MAX_CLEARANCE_M = 16;

const MAX_OFFSET_STATION_M = 5;
const ENDPOINT_KEY_PRECISION = 7;
const MIN_CONTINUATION_DOT = Math.cos(Math.PI / 4);

const FALLBACK_OFFSETS_BY_TYPE = {
    motorway: [0, -3.5, 3.5],
    motorway_link: [0],
    trunk: [0, -3.5, 3.5],
    trunk_link: [0],
};
const FALLBACK_OFFSETS_DEFAULT = [0];

export function laneMarkingFeatureKey(feature) {
    const properties = feature?.properties || {};
    const osmId = properties.osm_id ?? properties.osmId ?? feature?.id;
    return osmId != null
        ? `osm:${String(properties.osm_type || 'way')}:${String(osmId)}`
        : feature?.geometry
            ? `geometry:${JSON.stringify(feature.geometry)}`
            : null;
}

export function mergeLaneMarkingTileFeatures(tileFeatureGroups) {
    const unique = [];
    const seen = new Set();
    for (const features of tileFeatureGroups || []) {
        for (const feature of features || []) {
            const key = laneMarkingFeatureKey(feature);
            if (key != null && seen.has(key)) continue;
            if (key != null) seen.add(key);
            unique.push(feature);
        }
    }
    return unique;
}

export function parseLaneCount(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.max(1, Math.round(value));
    }
    if (typeof value !== 'string') return null;
    const match = value.match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function propertyOrTag(properties, ...keys) {
    for (const key of keys) {
        const value = properties?.[key] ?? properties?.tags?.[key];
        if (value != null && value !== '') return value;
    }
    return null;
}

export function getLaneCountForProperties(properties = {}) {
    const total = parseLaneCount(propertyOrTag(properties, 'lanes'));
    const forward = parseLaneCount(propertyOrTag(properties, 'lanes:forward', 'lanes_forward'));
    const backward = parseLaneCount(propertyOrTag(properties, 'lanes:backward', 'lanes_backward'));
    return Math.max(total || 0, (forward || 0) + (backward || 0)) || null;
}

export function getCarriagewayWidthM(properties = {}, laneCount = getLaneCountForProperties(properties)) {
    const explicitWidth = Number(propertyOrTag(properties, 'width_meters', 'width'));
    if (Number.isFinite(explicitWidth) && explicitWidth > 0) return explicitWidth;
    if (laneCount) {
        return laneCount * DEFAULT_MOTOR_LANE_WIDTH_M + DEFAULT_ROAD_EDGE_ALLOWANCE_M;
    }
    return null;
}

function normalizeOffsets(offsets) {
    return offsets
        .filter(Number.isFinite)
        .map((offset) => Math.round(offset * 1000) / 1000);
}

function getLaneCrossSectionForProperties(properties = {}) {
    const laneCount = getLaneCountForProperties(properties);
    if (laneCount && laneCount >= 2) {
        const carriagewayWidthM = getCarriagewayWidthM(properties, laneCount);
        const hasExplicitWidth = Number(propertyOrTag(properties, 'width_meters', 'width')) > 0;
        const paintableWidthM = hasExplicitWidth
            ? carriagewayWidthM
            : carriagewayWidthM - DEFAULT_ROAD_EDGE_ALLOWANCE_M;
        return {
            laneCount,
            laneWidthM: paintableWidthM / laneCount,
        };
    }
    if (laneCount === 1) {
        const carriagewayWidthM = getCarriagewayWidthM(properties, laneCount);
        const hasExplicitWidth = Number(propertyOrTag(properties, 'width_meters', 'width')) > 0;
        return {
            laneCount,
            laneWidthM: hasExplicitWidth
                ? carriagewayWidthM
                : carriagewayWidthM - DEFAULT_ROAD_EDGE_ALLOWANCE_M,
        };
    }
    return null;
}

export function getLaneBoundaryOffsetsForProperties(properties = {}) {
    const crossSection = getLaneCrossSectionForProperties(properties);
    if (!crossSection) return [];
    const { laneCount, laneWidthM } = crossSection;
    return normalizeOffsets(Array.from(
        { length: laneCount + 1 },
        (_, boundaryIndex) => (
            (boundaryIndex - laneCount / 2) * laneWidthM
        ),
    ));
}

export function getLaneMarkingOffsetsForProperties(properties = {}) {
    const crossSection = getLaneCrossSectionForProperties(properties);
    if (crossSection) {
        const { laneCount, laneWidthM } = crossSection;
        if (laneCount === 1) return [];
        return normalizeOffsets(Array.from(
            { length: laneCount - 1 },
            (_, boundaryIndex) => (
                (boundaryIndex + 1 - laneCount / 2) * laneWidthM
            ),
        ));
    }
    const highway = properties.highway || properties.highway_type || 'unclassified';
    return FALLBACK_OFFSETS_BY_TYPE[highway] || FALLBACK_OFFSETS_DEFAULT;
}

function cleanPoints(points) {
    return (points || [])
        .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.z))
        .filter((point, index, all) => (
            index === 0
            || Math.hypot(point.x - all[index - 1].x, point.z - all[index - 1].z) >= 0.05
        ));
}

export function buildOffsetPath(points, offsetM, options = {}) {
    const safePoints = cleanPoints(points);
    if (safePoints.length < 2) return [];
    const dense = options.densify === false
        ? { points: safePoints, widths: safePoints.map(() => 2) }
        : densifyChain(
            safePoints,
            safePoints.map(() => 2),
            MAX_OFFSET_STATION_M,
        );
    return computeRibbonStations(dense.points, dense.widths).map((station) => {
        const miterScale = station.halfWidth;
        return {
            x: station.x + station.nx * offsetM * miterScale,
            z: station.z + station.nz * offsetM * miterScale,
            arc: station.arc,
        };
    });
}

function endpointKey(coordinate) {
    return `${Number(coordinate[0]).toFixed(ENDPOINT_KEY_PRECISION)},${Number(coordinate[1]).toFixed(ENDPOINT_KEY_PRECISION)}`;
}

function cumulativeArcs(points) {
    const arcs = [];
    let arc = 0;
    let previous = null;
    for (const point of points || []) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) {
            arcs.push(null);
            continue;
        }
        if (previous) arc += Math.hypot(point.x - previous.x, point.z - previous.z);
        arcs.push(arc);
        previous = point;
    }
    return arcs;
}

function estimatedEntryWidthM(entry) {
    const properties = entry.feature.properties || {};
    const widthM = getCarriagewayWidthM(properties);
    if (Number.isFinite(widthM) && widthM > 0) return widthM;
    const maximumOffsetM = entry.paths.reduce(
        (maximum, path) => Math.max(maximum, Math.abs(path.offsetM)),
        0,
    );
    return Math.max(
        DEFAULT_MOTOR_LANE_WIDTH_M * 2 + DEFAULT_ROAD_EDGE_ALLOWANCE_M,
        maximumOffsetM * 2 + DEFAULT_MOTOR_LANE_WIDTH_M,
    );
}

// Junction paint is a topology decision, not a visual afterthought. OSM ways
// can pass through a shared node without being split there, so count incident
// line segments at every coordinate rather than looking only at feature ends.
function* buildRoadNodeIndexSteps(entries) {
    const byNode = new Map();
    const getNode = (key) => {
        if (!byNode.has(key)) {
            byNode.set(key, {
                segments: new Set(),
                touches: [],
                maximumWidthM: 0,
            });
        }
        return byNode.get(key);
    };
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex];
        const coordinates = entry.feature.geometry.coordinates;
        const widthM = estimatedEntryWidthM(entry);
        for (let vertexIndex = 0; vertexIndex < coordinates.length; vertexIndex++) {
            const coordinate = coordinates[vertexIndex];
            if (
                !Array.isArray(coordinate)
                || !Number.isFinite(Number(coordinate[0]))
                || !Number.isFinite(Number(coordinate[1]))
            ) {
                continue;
            }
            const key = endpointKey(coordinate);
            const node = getNode(key);
            const arc = entry.vertexArcs[vertexIndex];
            if (Number.isFinite(arc)) {
                node.touches.push({
                    entry,
                    arc,
                    side: vertexIndex === 0
                        ? 'start'
                        : vertexIndex === coordinates.length - 1
                            ? 'end'
                            : null,
                });
                node.maximumWidthM = Math.max(node.maximumWidthM, widthM);
            }
            if (vertexIndex > 0) node.segments.add(`${entryIndex}:${vertexIndex - 1}`);
            if (vertexIndex + 1 < coordinates.length) {
                node.segments.add(`${entryIndex}:${vertexIndex}`);
            }
        }
        yield 'node-index';
    }
    return byNode;
}

function endpointDescriptor(entry, side) {
    const coordinates = entry.feature.geometry.coordinates;
    const atStart = side === 'start';
    const endpointIndex = atStart ? 0 : coordinates.length - 1;
    const endpoint = entry.centerline[atStart ? 0 : entry.centerline.length - 1];
    const neighbor = entry.centerline[atStart ? 1 : entry.centerline.length - 2];
    const dx = neighbor.x - endpoint.x;
    const dz = neighbor.z - endpoint.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return null;
    return {
        entry,
        side,
        key: endpointKey(coordinates[endpointIndex]),
        outwardX: dx / length,
        outwardZ: dz / length,
    };
}

function normalizedName(properties) {
    return String(properties?.name || '').trim().toLocaleLowerCase();
}

function continuationScore(a, b, atIntersection = false) {
    if (a.entry === b.entry) return -Infinity;
    const oppositeDot = -(a.outwardX * b.outwardX + a.outwardZ * b.outwardZ);
    if (oppositeDot < MIN_CONTINUATION_DOT) return -Infinity;
    const aProperties = a.entry.feature.properties || {};
    const bProperties = b.entry.feature.properties || {};
    const aName = normalizedName(aProperties);
    const bName = normalizedName(bProperties);
    if (!atIntersection && aName && bName && aName !== bName) return -Infinity;
    const nameScore = aName && bName && aName === bName ? 2 : 0;
    const nameMismatchPenalty = aName && bName && aName !== bName ? 0.5 : 0;
    const aHighway = aProperties.highway || aProperties.highway_type;
    const bHighway = bProperties.highway || bProperties.highway_type;
    const classScore = aHighway && bHighway && aHighway === bHighway ? 0.35 : 0;
    return oppositeDot + nameScore + classScore - nameMismatchPenalty;
}

function* pairContinuationEndpointSteps(entries, roadNodes) {
    const byNode = new Map();
    for (const entry of entries) {
        for (const side of ['start', 'end']) {
            const endpoint = endpointDescriptor(entry, side);
            if (!endpoint) continue;
            if (!byNode.has(endpoint.key)) byNode.set(endpoint.key, []);
            byNode.get(endpoint.key).push(endpoint);
        }
        yield 'endpoint-index';
    }
    const pairs = [];
    for (const [key, endpoints] of byNode) {
        if (endpoints.length < 2) continue;
        const atIntersection = (roadNodes.get(key)?.segments.size || 0) > 2;
        const candidates = [];
        for (let left = 0; left < endpoints.length; left++) {
            for (let right = left + 1; right < endpoints.length; right++) {
                const score = continuationScore(
                    endpoints[left],
                    endpoints[right],
                    atIntersection,
                );
                if (Number.isFinite(score)) {
                    candidates.push({ a: endpoints[left], b: endpoints[right], score });
                }
            }
        }
        candidates.sort((a, b) => b.score - a.score);
        const used = new Set();
        for (const candidate of candidates) {
            if (used.has(candidate.a) || used.has(candidate.b)) continue;
            used.add(candidate.a);
            used.add(candidate.b);
            pairs.push([candidate.a, candidate.b]);
        }
        yield 'endpoint-pairs';
    }
    return pairs;
}

function pathEndpoint(path, side) {
    return path[side === 'start' ? 0 : path.length - 1];
}

function endpointDistance(a, b) {
    return Math.hypot(b.x - a.x, b.z - a.z);
}

function endpointMatchCost(sourcePoints, sourceIndexes, targetPoints, targetIndexes) {
    return sourceIndexes.reduce((total, sourceIndex, orderIndex) => (
        total + endpointDistance(
            sourcePoints[sourceIndex],
            targetPoints[targetIndexes[orderIndex]],
        )
    ), 0);
}

function edgeAwareTargetIndexCandidates(sourceIndexes, targetPoints) {
    if (targetPoints.length <= sourceIndexes.length) {
        return [targetPoints.map((_, index) => index)];
    }
    // At a one-lane expansion there is one more narrow-side boundary than
    // wide-side painted divider. Preserve every existing dashed divider and
    // choose one curb as the ancestor of the new outer divider.
    const withoutRightEdge = targetPoints
        .slice(0, sourceIndexes.length)
        .map((_, index) => index);
    const withoutLeftEdge = targetPoints
        .slice(targetPoints.length - sourceIndexes.length)
        .map((_, index) => targetPoints.length - sourceIndexes.length + index);
    return [withoutRightEdge, withoutLeftEdge];
}

function chooseOrderedEndpointMatches(
    sourcePaths,
    sourceSide,
    targetPaths,
    targetSide,
    preferredExpansionEdgeSourceIndex = null,
) {
    const sourcePoints = sourcePaths.map((path) => pathEndpoint(path.points, sourceSide));
    const targetPoints = targetPaths.map((path) => pathEndpoint(path.points, targetSide));
    if (sourcePoints.length === 0 || targetPoints.length === 0) {
        return {
            sourcePoints,
            targetPoints,
            matches: [],
            expansionEdgeSourceIndex: null,
        };
    }
    const matchCount = Math.min(sourcePoints.length, targetPoints.length);
    const sourceIndexes = sourcePaths
        .map((path, index) => ({ index, centrality: Math.abs(path.offsetM) }))
        .sort((a, b) => a.centrality - b.centrality || a.index - b.index)
        .slice(0, matchCount)
        .map(({ index }) => index)
        .sort((a, b) => a - b);
    const isOneLaneExpansion = targetPaths.length === sourcePaths.length + 1;
    const configurations = [];
    for (const targetIndexes of edgeAwareTargetIndexCandidates(
        sourceIndexes,
        targetPoints,
    )) {
        for (const orderedTargetIndexes of [
            targetIndexes,
            [...targetIndexes].reverse(),
        ]) {
            const matches = sourceIndexes.map((sourceIndex, orderIndex) => ({
                sourceIndex,
                targetIndex: orderedTargetIndexes[orderIndex],
            }));
            const edgeMatch = isOneLaneExpansion
                ? matches.find(({ targetIndex }) => targetPaths[targetIndex].kind === 'edge')
                : null;
            configurations.push({
                matches,
                cost: endpointMatchCost(
                    sourcePoints,
                    sourceIndexes,
                    targetPoints,
                    orderedTargetIndexes,
                ),
                expansionEdgeSourceIndex: edgeMatch?.sourceIndex ?? null,
            });
        }
    }
    configurations.sort((a, b) => {
        const aPreferred = Number.isInteger(preferredExpansionEdgeSourceIndex)
            && a.expansionEdgeSourceIndex === preferredExpansionEdgeSourceIndex;
        const bPreferred = Number.isInteger(preferredExpansionEdgeSourceIndex)
            && b.expansionEdgeSourceIndex === preferredExpansionEdgeSourceIndex;
        if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
        if (Math.abs(a.cost - b.cost) > 0.05) return a.cost - b.cost;
        return (
            (a.expansionEdgeSourceIndex ?? Number.MAX_SAFE_INTEGER)
            - (b.expansionEdgeSourceIndex ?? Number.MAX_SAFE_INTEGER)
        );
    });
    const selected = configurations[0];
    return {
        sourcePoints,
        targetPoints,
        matches: selected.matches,
        expansionEdgeSourceIndex: selected.expansionEdgeSourceIndex,
    };
}

function setEndpointTargets(source, target, options = {}) {
    const {
        fillUnmatched = false,
        targetBoundaries = false,
    } = options;
    const targetPaths = targetBoundaries
        ? target.entry.boundaryPaths
        : target.entry.paths;
    const {
        sourcePoints,
        targetPoints,
        matches,
        expansionEdgeSourceIndex,
    } = chooseOrderedEndpointMatches(
        source.entry.paths,
        source.side,
        targetPaths,
        target.side,
        source.entry.preferredExpansionEdgeSourceIndex,
    );
    if (sourcePoints.length === 0 || targetPoints.length === 0) return;
    if (
        targetBoundaries
        && Number.isInteger(expansionEdgeSourceIndex)
        && !Number.isInteger(source.entry.preferredExpansionEdgeSourceIndex)
    ) {
        source.entry.preferredExpansionEdgeSourceIndex = expansionEdgeSourceIndex;
    }
    const targets = sourcePoints.map(() => null);
    const usedSources = new Set();
    for (const match of matches) {
        const point = targetPoints[match.targetIndex];
        targets[match.sourceIndex] = {
            x: point.x,
            z: point.z,
            distance: endpointDistance(sourcePoints[match.sourceIndex], point),
            targetOffsetM: targetPaths[match.targetIndex].offsetM,
            targetKind: targetPaths[match.targetIndex].kind || 'marking',
        };
        usedSources.add(match.sourceIndex);
    }
    if (fillUnmatched) {
        const branches = sourcePoints.map(() => null);
        for (let sourceIndex = 0; sourceIndex < sourcePoints.length; sourceIndex++) {
            if (targets[sourceIndex]) continue;
            const sourcePoint = sourcePoints[sourceIndex];
            branches[sourceIndex] = [...usedSources].reduce((nearest, parentIndex) => {
                const point = sourcePoints[parentIndex];
                const distance = Math.hypot(
                    point.x - sourcePoint.x,
                    point.z - sourcePoint.z,
                );
                return !nearest || distance < nearest.distance
                    ? { parentIndex, distance }
                    : nearest;
            }, null)?.parentIndex ?? null;
        }
        source.entry.endpointBranches[source.side] = branches;
    }
    source.entry.endpointTargets[source.side] = targets;
}

function assignTransitionTargets(a, b) {
    const aLaneCount = getLaneCountForProperties(a.entry.feature.properties || {});
    const bLaneCount = getLaneCountForProperties(b.entry.feature.properties || {});
    const aCount = a.entry.paths.length;
    const bCount = b.entry.paths.length;
    if (aLaneCount && bLaneCount && aLaneCount !== bLaneCount) {
        // Lane continuity is defined by the full cross-section, including the
        // two curb edges. When a road widens by two lanes, the old curbs become
        // the new outer dashed dividers. The middle lane corridors can then
        // continue straight while only the new side lanes branch outward.
        if (aLaneCount > bLaneCount) {
            setEndpointTargets(a, b, {
                fillUnmatched: true,
                targetBoundaries: true,
            });
        } else {
            setEndpointTargets(b, a, {
                fillUnmatched: true,
                targetBoundaries: true,
            });
        }
        return;
    }
    if (aCount === bCount) {
        setEndpointTargets(b, a);
        return;
    }
    // Every marking on the larger side gets a continuation. First establish a
    // one-to-one match so none of the smaller side is orphaned, then let the
    // remaining branches reuse their nearest parent. Each branch stays a full,
    // independently dashed path.
    if (aCount > bCount) setEndpointTargets(a, b, { fillUnmatched: true });
    else setEndpointTargets(b, a, { fillUnmatched: true });
}

function applyEndpointTarget(path, side, target, transitionLengthM) {
    if (!target || path.length < 2) return;
    const endpointIndex = side === 'start' ? 0 : path.length - 1;
    const endpointArc = path[endpointIndex].arc;
    const dx = target.x - path[endpointIndex].x;
    const dz = target.z - path[endpointIndex].z;
    for (const point of path) {
        const distance = Math.abs(point.arc - endpointArc);
        if (distance >= transitionLengthM) continue;
        const progress = distance / transitionLengthM;
        const weight = 1 - progress * progress * (3 - 2 * progress);
        point.x += dx * weight;
        point.z += dz * weight;
    }
}

function applyEndpointBranch(path, parentPath, side, transitionLengthM) {
    if (!parentPath || path.length < 2 || parentPath.length < 2) return;
    const endpointIndex = side === 'start' ? 0 : path.length - 1;
    const endpointArc = path[endpointIndex].arc;
    for (const point of path) {
        const distance = Math.abs(point.arc - endpointArc);
        if (distance >= transitionLengthM) continue;
        const progress = distance / transitionLengthM;
        const weight = 1 - progress * progress * (3 - 2 * progress);
        const parentPoint = pointAtArc(parentPath, point.arc);
        point.x += (parentPoint.x - point.x) * weight;
        point.z += (parentPoint.z - point.z) * weight;
    }
}

function mergeIntervals(intervals) {
    const sorted = (intervals || [])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && interval[0] <= previous[1] + 1e-6) {
            previous[1] = Math.max(previous[1], interval[1]);
        } else {
            merged.push([...interval]);
        }
    }
    return merged;
}

function interpolatePathPoint(from, to, arc) {
    const span = to.arc - from.arc;
    if (span <= 1e-9) return { ...from, arc };
    const progress = (arc - from.arc) / span;
    return {
        x: from.x + (to.x - from.x) * progress,
        z: from.z + (to.z - from.z) * progress,
        arc,
    };
}

function pointAtArc(path, arc) {
    if (arc <= path[0].arc) return { ...path[0], arc };
    if (arc >= path[path.length - 1].arc) return { ...path[path.length - 1], arc };
    for (let index = 0; index + 1 < path.length; index++) {
        if (path[index + 1].arc + 1e-9 < arc) continue;
        return interpolatePathPoint(path[index], path[index + 1], arc);
    }
    return { ...path[path.length - 1], arc };
}

function slicePath(path, startArc, endArc) {
    if (endArc - startArc < 0.05) return [];
    const points = [pointAtArc(path, startArc)];
    for (const point of path) {
        if (point.arc > startArc + 1e-9 && point.arc < endArc - 1e-9) {
            points.push({ ...point });
        }
    }
    points.push(pointAtArc(path, endArc));
    return cleanPoints(points);
}

function splitPathOutsideIntervals(path, intervals) {
    if (path.length < 2 || intervals.length === 0) return [path];
    const startArc = path[0].arc;
    const endArc = path[path.length - 1].arc;
    const excluded = mergeIntervals(intervals.map(([start, end]) => [
        Math.max(startArc, start),
        Math.min(endArc, end),
    ]));
    const visible = [];
    let cursor = startArc;
    for (const [start, end] of excluded) {
        if (start > cursor + 0.05) visible.push(slicePath(path, cursor, start));
        cursor = Math.max(cursor, end);
    }
    if (cursor < endArc - 0.05) visible.push(slicePath(path, cursor, endArc));
    return visible.filter((points) => points.length >= 2);
}

function connectedEndpointId(entry, side) {
    return `${entry.topologyIndex}:${side}`;
}

function* applyJunctionClearanceSteps(entries, roadNodes, connectedEndpoints) {
    for (const node of roadNodes.values()) {
        if (node.segments.size > 2) {
            const clearanceM = Math.min(
                JUNCTION_MARKING_MAX_CLEARANCE_M,
                Math.max(
                    JUNCTION_MARKING_MIN_CLEARANCE_M,
                    node.maximumWidthM * 0.5 + JUNCTION_MARKING_SETBACK_M,
                ),
            );
            for (const touch of node.touches) {
                // An internal vertex is already an unambiguous through movement.
                // For split OSM ways, endpoint pairing provides the equivalent
                // inferred straight-through movement. Only ambiguous approaches
                // retain a setback before the conflict area.
                if (touch.side == null) continue;
                if (connectedEndpoints.has(connectedEndpointId(touch.entry, touch.side))) {
                    continue;
                }
                touch.entry.excludedIntervals.push([
                    touch.arc - clearanceM,
                    touch.arc + clearanceM,
                ]);
            }
        }
        yield 'junction-index';
    }
    for (const entry of entries) {
        entry.paths = entry.paths.flatMap((path) => {
            return splitPathOutsideIntervals(path.points, entry.excludedIntervals)
                .map((points) => ({
                    ...path,
                    points,
                }));
        });
        yield 'junction-split';
    }
}

// The cross-feature solve is intentionally global, but none of its stages must
// monopolise a frame. Yield after one road or topology node so the renderer can
// budget the same byte-identical solve cooperatively. The synchronous export
// below exhausts this iterator for tests, scripts and immediate user edits.
export function* buildLaneMarkingPathsResumable(features, toLocalPoint, options = {}) {
    const transitionLengthM = Math.max(
        5,
        Number(options.transitionLengthM) || LANE_TRANSITION_LENGTH_M,
    );
    const entries = [];
    for (const feature of features || []) {
        const coordinates = feature?.geometry?.type === 'LineString'
            ? feature.geometry.coordinates
            : null;
        if (!coordinates || coordinates.length < 2) continue;
        const localCoordinates = coordinates.map((coordinate) => toLocalPoint(coordinate));
        const centerline = cleanPoints(localCoordinates);
        if (centerline.length < 2) continue;
        const offsets = getLaneMarkingOffsetsForProperties(feature.properties || {});
        const paths = offsets
            .map((offsetM) => ({
                offsetM,
                points: buildOffsetPath(centerline, offsetM),
            }))
            .filter((path) => path.points.length >= 2);
        const boundaryOffsets = getLaneBoundaryOffsetsForProperties(feature.properties || {});
        const boundaryPaths = boundaryOffsets
            .map((offsetM, boundaryIndex) => ({
                offsetM,
                kind: boundaryIndex === 0 || boundaryIndex === boundaryOffsets.length - 1
                    ? 'edge'
                    : 'marking',
                points: buildOffsetPath(centerline, offsetM),
            }))
            .filter((path) => path.points.length >= 2);
        entries.push({
            topologyIndex: entries.length,
            feature,
            centerline,
            vertexArcs: cumulativeArcs(localCoordinates),
            paths,
            boundaryPaths,
            endpointTargets: { start: null, end: null },
            endpointBranches: { start: null, end: null },
            preferredExpansionEdgeSourceIndex: null,
            excludedIntervals: [],
        });
        yield 'entries';
    }
    const roadNodes = yield* buildRoadNodeIndexSteps(entries);
    const continuationPairs = yield* pairContinuationEndpointSteps(entries, roadNodes);
    const connectedEndpoints = new Set();
    for (const [a, b] of continuationPairs) {
        connectedEndpoints.add(connectedEndpointId(a.entry, a.side));
        connectedEndpoints.add(connectedEndpointId(b.entry, b.side));
        assignTransitionTargets(a, b);
        yield 'transition-pairs';
    }
    for (const entry of entries) {
        for (const side of ['start', 'end']) {
            const targets = entry.endpointTargets[side];
            if (!targets) continue;
            for (let index = 0; index < entry.paths.length; index++) {
                applyEndpointTarget(
                    entry.paths[index].points,
                    side,
                    targets[index],
                    transitionLengthM,
                );
            }
        }
        yield 'transition-targets';
    }
    for (const entry of entries) {
        for (const side of ['start', 'end']) {
            const branches = entry.endpointBranches[side];
            if (!branches) continue;
            for (let index = 0; index < entry.paths.length; index++) {
                const parentIndex = branches[index];
                if (!Number.isInteger(parentIndex)) continue;
                applyEndpointBranch(
                    entry.paths[index].points,
                    entry.paths[parentIndex]?.points,
                    side,
                    transitionLengthM,
                );
            }
        }
        yield 'transition-branches';
    }
    yield* applyJunctionClearanceSteps(entries, roadNodes, connectedEndpoints);
    return entries.filter((entry) => entry.paths.length > 0);
}

export function buildLaneMarkingPaths(features, toLocalPoint, options = {}) {
    const build = buildLaneMarkingPathsResumable(features, toLocalPoint, options);
    let outcome = build.next();
    while (!outcome.done) outcome = build.next();
    return outcome.value;
}
