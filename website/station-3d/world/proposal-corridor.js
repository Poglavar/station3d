// Converts consensus-builder road profiles into stable metric strip geometry for Station3D.
// The helpers are rendering-agnostic so proposal ingestion and browser tests share one schema adapter.

const LANE_TYPES = new Set([
    'driving',
    'bus',
    'parking',
    'cycleway',
    'sidewalk',
    'verge',
    'median',
    'rail',
]);
const DIRECTIONAL_TYPES = new Set(['driving', 'bus', 'cycleway']);
const DIRECTIONS = new Set(['forward', 'backward', 'both']);
const GREEN_TYPES = new Set(['verge', 'median']);
const MITRE_LIMIT = 4;
const METRES_PER_DEGREE_LAT = 111320;
// Authored proposal segments come through several save/split operations. A
// side-road endpoint can therefore miss the through-road centreline by a few
// decimetres even though the two road polygons visibly meet. Treat that as
// survey/editor noise, not as a grade separation. Interior/interior crossings
// remain untouched: without a shared vertex or an endpoint there is no
// topological evidence that an over/under crossing is an at-grade junction.
export const PROPOSAL_CORRIDOR_JUNCTION_SNAP_M = 0.75;
const PROPOSAL_CORRIDOR_JUNCTION_INDEX_CELL_M = 32;
const PROPOSAL_CORRIDOR_PARALLEL_COSINE = 0.985;
const PROPOSAL_CORRIDOR_JUNCTION_SHOULDER_M = 0.75;
// The rendered apron overlaps every branch mouth by a curb-scale amount. A
// mathematically tangent circle is not enough: the apron is an inscribed
// polygon and independently tessellated branch surfaces need a small shared
// plan area so floating-point interpolation can never reopen a sky seam.
const PROPOSAL_CORRIDOR_JUNCTION_OVERLAP_M = 0.2;

function pointCoordinate(point) {
    const lat = Number(point && (point.lat ?? (Array.isArray(point) ? point[1] : NaN)));
    const lng = Number(point && (point.lng ?? point.lon ?? (Array.isArray(point) ? point[0] : NaN)));
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function normalizeProposalCorridorProfile(profile) {
    const raw = Array.isArray(profile) ? profile : profile && profile.strips;
    if (!Array.isArray(raw)) return null;
    const strips = raw.map((input) => {
        const type = String(input && input.type || '').toLowerCase();
        const width = Number(input && input.width);
        if (!LANE_TYPES.has(type) || !Number.isFinite(width) || width <= 0) return null;
        const strip = { type, width };
        if (DIRECTIONAL_TYPES.has(type) && DIRECTIONS.has(input.direction)) {
            strip.direction = input.direction;
        }
        if (GREEN_TYPES.has(type)) {
            strip.landscape = input.landscape === 'trees' ? 'trees' : 'grass';
        }
        return strip;
    }).filter(Boolean);
    return strips.length > 0 ? { strips } : null;
}

export function proposalCorridorProfileWidth(profile) {
    const normalized = normalizeProposalCorridorProfile(profile);
    return normalized
        ? normalized.strips.reduce((total, strip) => total + strip.width, 0)
        : 0;
}

function normalizeLineStrings(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    // A centerline may be one array of {lat,lng} objects, one array of [lng,lat]
    // pairs, or an array of such lines. Testing the first item as a coordinate
    // disambiguates the latter two shapes without relying on object-only data.
    const source = pointCoordinate(raw[0]) ? [raw] : raw;
    return source.map((line) => (
        Array.isArray(line) ? line.map(pointCoordinate).filter(Boolean) : []
    )).filter((line) => line.length >= 2);
}

export function proposalCorridorSegmentEntries(roadPlan, fallbackWidthM = 8) {
    if (!roadPlan || typeof roadPlan !== 'object') return [];
    const lines = normalizeLineStrings(roadPlan.points || roadPlan.segments);
    const ids = Array.isArray(roadPlan.segmentIds) ? roadPlan.segmentIds : [];
    const overrides = roadPlan.segmentProfiles && typeof roadPlan.segmentProfiles === 'object'
        ? roadPlan.segmentProfiles
        : {};
    const defaultProfile = normalizeProposalCorridorProfile(roadPlan.profile);
    const declaredWidth = Number(roadPlan.width);
    return lines.map((points, index) => {
        const id = ids[index] == null ? `segment-${index + 1}` : String(ids[index]);
        const profile = normalizeProposalCorridorProfile(overrides[id]) || defaultProfile;
        const profileWidth = proposalCorridorProfileWidth(profile);
        const widthM = profileWidth > 0
            ? profileWidth
            : (Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth : fallbackWidthM);
        return { id, points, profile, widthM };
    });
}

export function proposalCorridorStripSpans(profile) {
    const normalized = normalizeProposalCorridorProfile(profile);
    if (!normalized) return [];
    let cursor = proposalCorridorProfileWidth(normalized) / 2;
    return normalized.strips.map((strip, index) => {
        const left = cursor;
        cursor -= strip.width;
        return { ...strip, index, left, right: cursor };
    });
}

function projectionForLine(points) {
    const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const averageLng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
    const metresPerDegreeLng = METRES_PER_DEGREE_LAT * Math.cos(averageLat * Math.PI / 180);
    return {
        toPlanar(point) {
            return [
                (point.lng - averageLng) * metresPerDegreeLng,
                (point.lat - averageLat) * METRES_PER_DEGREE_LAT,
            ];
        },
        toLatLng(point) {
            return {
                lng: averageLng + point[0] / metresPerDegreeLng,
                lat: averageLat + point[1] / METRES_PER_DEGREE_LAT,
            };
        },
    };
}

// Positive offsets are left of the line direction. Outside bends are bevelled while inside bends
// are mitred, matching the corridor geometry used by consensus-builder without long corner spikes.
function offsetPolylinePlanar(points, offset) {
    const edges = [];
    for (let index = 0; index < points.length - 1; index++) {
        const dx = points[index + 1][0] - points[index][0];
        const dy = points[index + 1][1] - points[index][1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-9) continue;
        edges.push({
            index,
            direction: [dx / length, dy / length],
            normal: [-dy / length, dx / length],
        });
    }
    if (edges.length === 0) return null;
    const moved = (point, normal) => [
        point[0] + normal[0] * offset,
        point[1] + normal[1] * offset,
    ];
    const result = [moved(points[edges[0].index], edges[0].normal)];
    for (let index = 1; index < edges.length; index++) {
        const previous = edges[index - 1];
        const next = edges[index];
        const vertex = points[next.index];
        const sumX = previous.normal[0] + next.normal[0];
        const sumY = previous.normal[1] + next.normal[1];
        const sumLength = Math.hypot(sumX, sumY);
        const cross = previous.direction[0] * next.direction[1]
            - previous.direction[1] * next.direction[0];
        const outside = cross > 0 ? offset < 0 : offset > 0;
        const bevel = () => {
            result.push(moved(vertex, previous.normal), moved(vertex, next.normal));
        };
        if (sumLength < 1e-9 || outside || Math.abs(cross) < 1e-12) {
            bevel();
            continue;
        }
        const mitre = [sumX / sumLength, sumY / sumLength];
        const cosHalf = mitre[0] * previous.normal[0] + mitre[1] * previous.normal[1];
        if (Math.abs(cosHalf) < 1 / MITRE_LIMIT) {
            bevel();
            continue;
        }
        result.push([
            vertex[0] + mitre[0] * offset / cosHalf,
            vertex[1] + mitre[1] * offset / cosHalf,
        ]);
    }
    const last = edges[edges.length - 1];
    result.push(moved(points[last.index + 1], last.normal));
    return result;
}

export function buildProposalCorridorStripRing(points, left, right) {
    const line = Array.isArray(points) ? points.map(pointCoordinate).filter(Boolean) : [];
    if (line.length < 2 || !Number.isFinite(left) || !Number.isFinite(right) || left === right) return null;
    const projection = projectionForLine(line);
    const planar = line.map(projection.toPlanar);
    const leftSide = offsetPolylinePlanar(planar, Math.max(left, right));
    const rightSide = offsetPolylinePlanar(planar, Math.min(left, right));
    if (!leftSide || !rightSide) return null;
    const ring = [...leftSide, ...rightSide.reverse()].map((point) => {
        const latLng = projection.toLatLng(point);
        return [latLng.lng, latLng.lat];
    });
    if (ring.length >= 3) ring.push(ring[0].slice());
    return ring;
}

export function proposalCorridorLaneSeparators(profile) {
    const spans = proposalCorridorStripSpans(profile);
    const separators = [];
    const isTraffic = (strip) => strip && (strip.type === 'driving' || strip.type === 'bus');
    for (let index = 0; index < spans.length - 1; index++) {
        const left = spans[index];
        const right = spans[index + 1];
        if (!isTraffic(left) || !isTraffic(right)) continue;
        separators.push({
            offset: left.right,
            kind: left.direction && right.direction && left.direction !== right.direction
                ? 'centerline'
                : 'lane',
        });
    }
    return separators;
}

export function proposalCorridorPointKey(point) {
    const coordinate = pointCoordinate(point);
    return coordinate ? `${coordinate.lat.toFixed(7)}|${coordinate.lng.toFixed(7)}` : '';
}

function planarSegmentProjection(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 1e-12
        ? Math.max(0, Math.min(1,
            ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared))
        : 0;
    const x = a[0] + dx * t;
    const y = a[1] + dy * t;
    return {
        t,
        point: [x, y],
        distanceM: Math.hypot(point[0] - x, point[1] - y),
    };
}

function endpointDirection(segment, atStart) {
    const dx = atStart
        ? segment.b[0] - segment.a[0]
        : segment.a[0] - segment.b[0];
    const dy = atStart
        ? segment.b[1] - segment.a[1]
        : segment.a[1] - segment.b[1];
    const length = Math.hypot(dx, dy);
    return length > 1e-9 ? [dx / length, dy / length] : null;
}

function segmentDirection(segment) {
    const dx = segment.b[0] - segment.a[0];
    const dy = segment.b[1] - segment.a[1];
    const length = Math.hypot(dx, dy);
    return length > 1e-9 ? [dx / length, dy / length] : null;
}

function expandedSegmentCellKeys(segment, expansionM, cellM) {
    const minX = Math.min(segment.a[0], segment.b[0]) - expansionM;
    const maxX = Math.max(segment.a[0], segment.b[0]) + expansionM;
    const minY = Math.min(segment.a[1], segment.b[1]) - expansionM;
    const maxY = Math.max(segment.a[1], segment.b[1]) + expansionM;
    const keys = [];
    for (let cellY = Math.floor(minY / cellM); cellY <= Math.floor(maxY / cellM); cellY++) {
        for (let cellX = Math.floor(minX / cellM); cellX <= Math.floor(maxX / cellM); cellX++) {
            keys.push(`${cellX}|${cellY}`);
        }
    }
    return keys;
}

function addTopologyTouch(node, segment, t) {
    const clamped = Math.max(0, Math.min(1, Number(t) || 0));
    if (node.touches.some(touch => (
        touch.entryIndex === segment.entryIndex
        && touch.segmentIndex === segment.segmentIndex
        && Math.abs(touch.t - clamped) <= 1e-7
    ))) return;
    node.touches.push({
        entryIndex: segment.entryIndex,
        segmentIndex: segment.segmentIndex,
        t: clamped,
    });
}

// Reconcile only endpoint-backed road meetings. The returned entries retain
// every source field but receive new point arrays with one byte-identical
// lat/lng object at each shared node. RoadFormationModel can then anchor all
// incident longitudinal profiles to one elevation, and junction detection can
// trim every arm against one common envelope.
export function topologizeProposalCorridorEntries(entries, {
    snapM = PROPOSAL_CORRIDOR_JUNCTION_SNAP_M,
    indexCellM = PROPOSAL_CORRIDOR_JUNCTION_INDEX_CELL_M,
} = {}) {
    const source = (Array.isArray(entries) ? entries : []).map((entry) => ({
        ...entry,
        points: (Array.isArray(entry?.points) ? entry.points : [])
            .map(pointCoordinate)
            .filter(Boolean),
    }));
    const allPoints = source.flatMap(entry => entry.points);
    const safeSnapM = Math.max(0, Number(snapM) || 0);
    const safeCellM = Math.max(4, Number(indexCellM) || PROPOSAL_CORRIDOR_JUNCTION_INDEX_CELL_M);
    if (source.length < 2 || allPoints.length < 3 || safeSnapM <= 0) return source;
    const projection = projectionForLine(allPoints);
    const planarLines = source.map(entry => entry.points.map(projection.toPlanar));
    const segments = [];
    for (let entryIndex = 0; entryIndex < planarLines.length; entryIndex++) {
        const line = planarLines[entryIndex];
        for (let segmentIndex = 0; segmentIndex < line.length - 1; segmentIndex++) {
            const a = line[segmentIndex];
            const b = line[segmentIndex + 1];
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 1e-6) continue;
            segments.push({
                index: segments.length,
                entryIndex,
                segmentIndex,
                a,
                b,
                startIsEntryEndpoint: segmentIndex === 0,
                endIsEntryEndpoint: segmentIndex === line.length - 2,
            });
        }
    }
    if (segments.length < 2) return source;

    const segmentBuckets = new Map();
    for (const segment of segments) {
        for (const key of expandedSegmentCellKeys(segment, safeSnapM, safeCellM)) {
            const bucket = segmentBuckets.get(key);
            if (bucket) bucket.push(segment);
            else segmentBuckets.set(key, [segment]);
        }
    }
    const nodeBuckets = new Map();
    const nodes = [];
    const nodeAt = (point) => {
        const cellX = Math.floor(point[0] / safeSnapM);
        const cellY = Math.floor(point[1] / safeSnapM);
        let best = null;
        let bestDistance = safeSnapM;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (const node of nodeBuckets.get(`${cellX + dx}|${cellY + dy}`) || []) {
                    const distance = Math.hypot(node.point[0] - point[0], node.point[1] - point[1]);
                    if (distance <= bestDistance) {
                        bestDistance = distance;
                        best = node;
                    }
                }
            }
        }
        if (best) return best;
        const node = { point: point.slice(), touches: [] };
        nodes.push(node);
        const key = `${cellX}|${cellY}`;
        const bucket = nodeBuckets.get(key);
        if (bucket) bucket.push(node);
        else nodeBuckets.set(key, [node]);
        return node;
    };
    const registerEndpoint = (endpointSegment, atStart, targetSegment) => {
        if (endpointSegment.entryIndex === targetSegment.entryIndex) return;
        const endpoint = atStart ? endpointSegment.a : endpointSegment.b;
        const projected = planarSegmentProjection(endpoint, targetSegment.a, targetSegment.b);
        if (projected.distanceM > safeSnapM) return;
        const targetAtEndpoint = projected.t <= 1e-7 || projected.t >= 1 - 1e-7;
        if (!targetAtEndpoint && projected.distanceM > 0.05) {
            const endpointTangent = endpointDirection(endpointSegment, atStart);
            const targetTangent = segmentDirection(targetSegment);
            const cosine = endpointTangent && targetTangent
                ? Math.abs(endpointTangent[0] * targetTangent[0]
                    + endpointTangent[1] * targetTangent[1])
                : 1;
            // A nearly parallel endpoint beside the middle of another road is
            // a frontage/service-road neighbour, not a junction. Collinear
            // endpoint-to-endpoint continuations remain connected above.
            if (cosine >= PROPOSAL_CORRIDOR_PARALLEL_COSINE) return;
        }
        const node = nodeAt(projected.point);
        addTopologyTouch(node, endpointSegment, atStart ? 0 : 1);
        addTopologyTouch(node, targetSegment, projected.t);
    };

    const seenPairs = new Set();
    for (const bucket of segmentBuckets.values()) {
        for (let leftIndex = 0; leftIndex < bucket.length; leftIndex++) {
            const left = bucket[leftIndex];
            for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex++) {
                const right = bucket[rightIndex];
                if (left.entryIndex === right.entryIndex) continue;
                const pairKey = left.index < right.index
                    ? `${left.index}|${right.index}`
                    : `${right.index}|${left.index}`;
                if (seenPairs.has(pairKey)) continue;
                seenPairs.add(pairKey);
                if (left.startIsEntryEndpoint) registerEndpoint(left, true, right);
                if (left.endIsEntryEndpoint) registerEndpoint(left, false, right);
                if (right.startIsEntryEndpoint) registerEndpoint(right, true, left);
                if (right.endIsEntryEndpoint) registerEndpoint(right, false, left);
            }
        }
    }
    if (nodes.length === 0) return source;

    const replacementByEntry = source.map(() => new Map());
    const insertionsByEntry = source.map(() => new Map());
    for (const node of nodes) {
        if (new Set(node.touches.map(touch => touch.entryIndex)).size < 2) continue;
        const geographic = projection.toLatLng(node.point);
        node.geographic = geographic;
        for (const touch of node.touches) {
            if (touch.t <= 1e-7) {
                replacementByEntry[touch.entryIndex].set(touch.segmentIndex, geographic);
            } else if (touch.t >= 1 - 1e-7) {
                replacementByEntry[touch.entryIndex].set(touch.segmentIndex + 1, geographic);
            } else {
                const bySegment = insertionsByEntry[touch.entryIndex];
                const list = bySegment.get(touch.segmentIndex) || [];
                if (!list.some(item => Math.abs(item.t - touch.t) <= 1e-7)) {
                    list.push({ t: touch.t, point: geographic });
                    bySegment.set(touch.segmentIndex, list);
                }
            }
        }
    }
    return source.map((entry, entryIndex) => {
        const points = [];
        const replacements = replacementByEntry[entryIndex];
        const insertions = insertionsByEntry[entryIndex];
        for (let pointIndex = 0; pointIndex < entry.points.length; pointIndex++) {
            points.push(replacements.get(pointIndex) || entry.points[pointIndex]);
            if (pointIndex >= entry.points.length - 1) continue;
            for (const insertion of (insertions.get(pointIndex) || [])
                .sort((a, b) => a.t - b.t)) {
                points.push(insertion.point);
            }
        }
        const deduped = points.filter((point, index) => (
            index === 0 || proposalCorridorPointKey(point)
                !== proposalCorridorPointKey(points[index - 1])
        ));
        return { ...entry, points: deduped };
    });
}

export function findProposalCorridorJunctions(entries) {
    const nodes = new Map();
    const addArm = (point, other, entry) => {
        const key = proposalCorridorPointKey(point);
        if (!key) return;
        const projection = projectionForLine([point, other]);
        const origin = projection.toPlanar(point);
        const target = projection.toPlanar(other);
        const dx = target[0] - origin[0];
        const dy = target[1] - origin[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-9) return;
        if (!nodes.has(key)) {
            nodes.set(key, {
                key,
                lat: point.lat,
                lng: point.lng,
                entryIds: new Set(),
                arms: [],
                armDescriptors: [],
                trimM: 0,
                maxHalfWidthM: 0,
                radiusM: 0,
            });
        }
        const node = nodes.get(key);
        const arm = [dx / length, dy / length];
        const widthM = Number(entry?.widthM);
        const halfWidthM = Number.isFinite(widthM) && widthM > 0 ? widthM / 2 : 0.5;
        const matchingArmIndex = node.arms.findIndex(
            existing => existing[0] * arm[0] + existing[1] * arm[1] > 0.9999,
        );
        if (matchingArmIndex < 0) {
            node.arms.push(arm);
            node.armDescriptors.push({ direction: arm, halfWidthM });
        } else {
            node.armDescriptors[matchingArmIndex].halfWidthM = Math.max(
                node.armDescriptors[matchingArmIndex].halfWidthM,
                halfWidthM,
            );
        }
        node.entryIds.add(entry.topologyId ?? entry.id);
        node.trimM = Math.max(
            node.trimM,
            halfWidthM + PROPOSAL_CORRIDOR_JUNCTION_SHOULDER_M,
        );
        node.maxHalfWidthM = Math.max(node.maxHalfWidthM, halfWidthM);
        // `trimM` is a CENTERLINE distance, while the apron must reach the
        // outer mouth CORNERS. Reusing one radius for both left triangular
        // holes between the old circular patch and every incident branch.
        node.radiusM = Math.hypot(
            node.trimM + PROPOSAL_CORRIDOR_JUNCTION_OVERLAP_M,
            node.maxHalfWidthM,
        );
    };
    for (const entry of entries || []) {
        const points = Array.isArray(entry && entry.points) ? entry.points : [];
        for (let index = 0; index < points.length; index++) {
            if (index > 0) addArm(points[index], points[index - 1], entry);
            if (index < points.length - 1) addArm(points[index], points[index + 1], entry);
        }
    }
    return new Map([...nodes].filter(([, node]) => node.arms.length >= 3));
}

function convexHullPlanar(points) {
    const sorted = (Array.isArray(points) ? points : [])
        .map(point => [Number(point?.[0]), Number(point?.[1])])
        .filter(point => point.every(Number.isFinite))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const unique = sorted.filter((point, index) => (
        index === 0
        || Math.hypot(point[0] - sorted[index - 1][0], point[1] - sorted[index - 1][1]) > 1e-7
    ));
    if (unique.length < 3) return [];
    const cross = (origin, a, b) => (
        (a[0] - origin[0]) * (b[1] - origin[1])
        - (a[1] - origin[1]) * (b[0] - origin[0])
    );
    const half = (source) => {
        const output = [];
        for (const point of source) {
            while (output.length >= 2
                && cross(output[output.length - 2], output[output.length - 1], point) <= 1e-9) {
                output.pop();
            }
            output.push(point);
        }
        return output;
    };
    const lower = half(unique);
    const upper = half([...unique].reverse());
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// The apron boundary is the convex hull of the incident branch mouths. That
// yields an ordinary intersection envelope (with one straight shared mouth
// per approach), rather than a freestanding circle hovering between them.
export function buildProposalCorridorJunctionRing(junction) {
    const lat = Number(junction?.lat);
    const lng = Number(junction?.lng);
    const trimM = Number(junction?.trimM);
    const descriptors = Array.isArray(junction?.armDescriptors)
        ? junction.armDescriptors
        : [];
    if (![lat, lng, trimM].every(Number.isFinite)
        || trimM <= 0
        || descriptors.length < 3) return null;
    const mouthDistanceM = trimM + PROPOSAL_CORRIDOR_JUNCTION_OVERLAP_M;
    const mouthCorners = [];
    for (const descriptor of descriptors) {
        const dx = Number(descriptor?.direction?.[0]);
        const dy = Number(descriptor?.direction?.[1]);
        const halfWidthM = Number(descriptor?.halfWidthM);
        if (![dx, dy, halfWidthM].every(Number.isFinite) || halfWidthM <= 0) continue;
        const normalX = -dy;
        const normalY = dx;
        const centerX = dx * mouthDistanceM;
        const centerY = dy * mouthDistanceM;
        mouthCorners.push(
            [centerX + normalX * halfWidthM, centerY + normalY * halfWidthM],
            [centerX - normalX * halfWidthM, centerY - normalY * halfWidthM],
        );
    }
    // A rare fan junction can have every arm in one hemisphere. Keep a tiny
    // node-centered kernel in the hull so that topology still reaches the
    // branch mouths instead of leaving the shared node outside the apron.
    const kernelM = PROPOSAL_CORRIDOR_JUNCTION_OVERLAP_M;
    mouthCorners.push(
        [-kernelM, -kernelM],
        [kernelM, -kernelM],
        [kernelM, kernelM],
        [-kernelM, kernelM],
    );
    const hull = convexHullPlanar(mouthCorners);
    if (hull.length < 3) return null;
    const metresPerDegreeLng = METRES_PER_DEGREE_LAT * Math.cos(lat * Math.PI / 180);
    const ring = hull.map(point => [
        lng + point[0] / metresPerDegreeLng,
        lat + point[1] / METRES_PER_DEGREE_LAT,
    ]);
    ring.push(ring[0].slice());
    return ring;
}

function trimPlanarLine(points, startM, endM) {
    const cumulative = [0];
    for (let index = 1; index < points.length; index++) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
            points[index][0] - points[index - 1][0],
            points[index][1] - points[index - 1][1],
        ));
    }
    const total = cumulative[cumulative.length - 1];
    const start = Math.max(0, Number(startM) || 0);
    const end = total - Math.max(0, Number(endM) || 0);
    if (!(end - start > 0.25)) return null;
    const pointAt = (distance) => {
        for (let index = 0; index < cumulative.length - 1; index++) {
            if (distance > cumulative[index + 1]) continue;
            const span = cumulative[index + 1] - cumulative[index] || 1;
            const t = Math.max(0, Math.min(1, (distance - cumulative[index]) / span));
            return [
                points[index][0] + (points[index + 1][0] - points[index][0]) * t,
                points[index][1] + (points[index + 1][1] - points[index][1]) * t,
            ];
        }
        return points[points.length - 1].slice();
    };
    const output = [pointAt(start)];
    for (let index = 1; index < points.length - 1; index++) {
        if (cumulative[index] > start && cumulative[index] < end) output.push(points[index].slice());
    }
    output.push(pointAt(end));
    return output;
}

export function splitProposalCorridorAtJunctions(entry, junctions) {
    const points = Array.isArray(entry && entry.points) ? entry.points.map(pointCoordinate).filter(Boolean) : [];
    if (points.length < 2) return [];
    const boundaryIndexes = [0];
    for (let index = 1; index < points.length - 1; index++) {
        if (junctions && junctions.has(proposalCorridorPointKey(points[index]))) boundaryIndexes.push(index);
    }
    boundaryIndexes.push(points.length - 1);
    const pieces = [];
    for (let index = 0; index < boundaryIndexes.length - 1; index++) {
        const startIndex = boundaryIndexes[index];
        const endIndex = boundaryIndexes[index + 1];
        const source = points.slice(startIndex, endIndex + 1);
        const projection = projectionForLine(source);
        const planar = source.map(projection.toPlanar);
        const startJunction = junctions && junctions.get(proposalCorridorPointKey(source[0]));
        const endJunction = junctions && junctions.get(proposalCorridorPointKey(source[source.length - 1]));
        const trimmed = trimPlanarLine(
            planar,
            startJunction ? startJunction.trimM : 0,
            endJunction ? endJunction.trimM : 0,
        );
        if (!trimmed) continue;
        pieces.push({
            points: trimmed.map(projection.toLatLng),
            junctionStart: !!startJunction,
            junctionEnd: !!endJunction,
            startJunctionKey: startJunction?.key || null,
            endJunctionKey: endJunction?.key || null,
        });
    }
    return pieces;
}

export function sampleProposalCorridorOffset(points, offsetM, spacingM, edgeMarginM = 0) {
    const line = Array.isArray(points) ? points.map(pointCoordinate).filter(Boolean) : [];
    if (line.length < 2 || !(spacingM > 0)) return [];
    const projection = projectionForLine(line);
    const offset = offsetPolylinePlanar(line.map(projection.toPlanar), Number(offsetM) || 0);
    if (!offset || offset.length < 2) return [];
    const cumulative = [0];
    for (let index = 1; index < offset.length; index++) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
            offset[index][0] - offset[index - 1][0],
            offset[index][1] - offset[index - 1][1],
        ));
    }
    const total = cumulative[cumulative.length - 1];
    const margin = Math.max(0, Number(edgeMarginM) || 0);
    if (total <= margin * 2 + 0.1) return [];
    const first = total < spacingM + margin * 2 ? total / 2 : margin + spacingM / 2;
    const samples = [];
    for (let distance = first; distance <= total - margin + 1e-9; distance += spacingM) {
        let edgeIndex = 0;
        while (edgeIndex < cumulative.length - 2 && distance > cumulative[edgeIndex + 1]) edgeIndex++;
        const edgeLength = cumulative[edgeIndex + 1] - cumulative[edgeIndex] || 1;
        const t = Math.max(0, Math.min(1, (distance - cumulative[edgeIndex]) / edgeLength));
        const dx = offset[edgeIndex + 1][0] - offset[edgeIndex][0];
        const dy = offset[edgeIndex + 1][1] - offset[edgeIndex][1];
        const location = [
            offset[edgeIndex][0] + dx * t,
            offset[edgeIndex][1] + dy * t,
        ];
        const latLng = projection.toLatLng(location);
        samples.push({
            ...latLng,
            angleRad: Math.atan2(dy, dx),
        });
    }
    return samples;
}
