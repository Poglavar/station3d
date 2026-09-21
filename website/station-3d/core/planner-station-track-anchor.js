// Resolves a planner station onto one rendered track sample so its centre,
// tangent and elevation cannot be chosen from different route fragments.

export const MIN_STATION_TRACK_CHORD_M = 0.01;

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function trackKey(value) {
    return value == null ? null : String(value);
}

export function stationTrackRouteMatches(route, stopTrackId) {
    const wanted = trackKey(stopTrackId);
    if (wanted == null) return true;
    const direct = trackKey(route?.trackId);
    if (direct != null) return direct === wanted;
    return (route?.trackIds || []).some(value => trackKey(value) === wanted);
}

export function splitStationTrackRouteBySegmentOwners(route = {}) {
    const points = route.points || [];
    const owners = route.segmentTrackIds;
    if (!Array.isArray(owners) || owners.length !== points.length - 1) return [route];
    const pieces = [];
    let start = 0;
    while (start < owners.length) {
        const owner = trackKey(owners[start]);
        let end = start + 1;
        while (end < owners.length && trackKey(owners[end]) === owner) end++;
        pieces.push({
            ...route,
            routeKey: `${route.routeKey ?? 0}:${start}`,
            trackId: owner ?? route.trackId ?? null,
            trackIds: owner == null ? (route.trackIds || []) : [owner],
            segmentTrackIds: null,
            points: points.slice(start, end + 1),
        });
        start = end;
    }
    return pieces;
}

export function prepareStationTrackRoutes(routes = []) {
    const prepared = [];
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex] || {};
        const points = (route.points || [])
            .map(point => ({
                ...point,
                x: finite(point?.x),
                z: finite(point?.z),
                y: finite(point?.y, 0),
                relativeHeightM: finite(point?.relativeHeightM, 0),
                lon: finite(point?.lon),
                lat: finite(point?.lat),
            }))
            .filter(point => point.x != null && point.z != null);
        if (points.length < 2) continue;

        const chainagesM = [0];
        for (let index = 1; index < points.length; index++) {
            chainagesM.push(chainagesM[index - 1] + Math.hypot(
                points[index].x - points[index - 1].x,
                points[index].z - points[index - 1].z,
            ));
        }
        if (chainagesM[chainagesM.length - 1] < 1e-6) continue;
        prepared.push({
            ...route,
            routeKey: route.routeKey ?? routeIndex,
            points,
            chainagesM,
            lengthM: chainagesM[chainagesM.length - 1],
        });
    }
    return prepared;
}

// Reassembles the per-chord representation used by underground.js without
// inventing links between distinct owner runs. Kept here beside the canonical
// sampler so its sub-metre curve policy has a pure Node-testable contract.
export function prepareStationTrackRoutesFromSegments(segments = []) {
    const grouped = new Map();
    for (const segment of segments || []) {
        if (!segment) continue;
        const lengthM = Number.isFinite(Number(segment.length))
            ? Number(segment.length)
            : Math.hypot(
                Number(segment.end?.x) - Number(segment.start?.x),
                Number(segment.end?.z) - Number(segment.start?.z),
            );
        if (!Number.isFinite(lengthM) || lengthM < MIN_STATION_TRACK_CHORD_M) continue;
        let route = grouped.get(segment.routeKey);
        if (!route) {
            route = {
                routeKey: segment.routeKey,
                routeRunId: segment.routeRunId,
                trackId: segment.trackId,
                trackIds: Array.isArray(segment.properties?.trackIds)
                    ? segment.properties.trackIds
                    : [],
                properties: segment.properties,
                usesPhotoFrame: !!segment.usesPhotoTrackFrame,
                segments: [],
            };
            grouped.set(segment.routeKey, route);
        }
        route.segments.push(segment);
    }
    return prepareStationTrackRoutes([...grouped.values()].map((route) => {
        route.segments.sort((left, right) => left.routeOrder - right.routeOrder);
        return {
            ...route,
            points: [
                route.segments[0].start,
                ...route.segments.map(segment => segment.end),
            ].map(point => ({
                ...point,
                relativeHeightM: point.relativeHeightM ?? point.y,
            })),
        };
    }));
}

function interpolateOptional(from, to, t) {
    return from == null || to == null ? null : from + (to - from) * t;
}

export function samplePreparedStationTrackRoute(route, requestedChainageM) {
    const chainageM = Math.max(0, Math.min(route.lengthM, finite(requestedChainageM, 0)));
    let segmentIndex = route.points.length - 2;
    for (let index = 0; index < route.chainagesM.length - 1; index++) {
        if (chainageM <= route.chainagesM[index + 1]) {
            segmentIndex = index;
            break;
        }
    }
    const startM = route.chainagesM[segmentIndex];
    const endM = route.chainagesM[segmentIndex + 1];
    const spanM = endM - startM;
    const t = spanM > 1e-9 ? (chainageM - startM) / spanM : 0;
    const from = route.points[segmentIndex];
    const to = route.points[segmentIndex + 1];
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
        relativeHeightM: from.relativeHeightM
            + (to.relativeHeightM - from.relativeHeightM) * t,
        lon: interpolateOptional(from.lon, to.lon, t),
        lat: interpolateOptional(from.lat, to.lat, t),
        chainageM,
        segmentIndex,
        t,
    };
}

function tangentAt(route, chainageM, halfSpanM, fallbackSegmentIndex) {
    const spanM = Math.max(0.5, finite(halfSpanM, 8));
    const before = samplePreparedStationTrackRoute(route, chainageM - spanM);
    const after = samplePreparedStationTrackRoute(route, chainageM + spanM);
    let dx = after.x - before.x;
    let dz = after.z - before.z;
    let lengthM = Math.hypot(dx, dz);
    if (lengthM < 1e-6) {
        const from = route.points[fallbackSegmentIndex];
        const to = route.points[fallbackSegmentIndex + 1];
        dx = to.x - from.x;
        dz = to.z - from.z;
        lengthM = Math.hypot(dx, dz);
    }
    if (lengthM < 1e-6) return null;
    return {
        alongX: dx / lengthM,
        alongZ: dz / lengthM,
        rightX: -dz / lengthM,
        rightZ: dx / lengthM,
    };
}

export function resolvePlannerStationTrackAnchor({
    stopX,
    stopZ,
    stopTrackId = null,
    usePhotoFrame = null,
    routes = [],
    tangentHalfSpanM = 8,
    maxSnapDistanceM = Infinity,
} = {}) {
    const queryX = finite(stopX);
    const queryZ = finite(stopZ);
    if (queryX == null || queryZ == null) return null;

    let nearest = null;
    for (const route of routes || []) {
        if (!stationTrackRouteMatches(route, stopTrackId)) continue;
        if (typeof usePhotoFrame === 'boolean'
            && !!route.usesPhotoFrame !== usePhotoFrame) continue;
        for (let segmentIndex = 0; segmentIndex < route.points.length - 1; segmentIndex++) {
            const from = route.points[segmentIndex];
            const to = route.points[segmentIndex + 1];
            const dx = to.x - from.x;
            const dz = to.z - from.z;
            const lengthSq = dx * dx + dz * dz;
            if (lengthSq < 1e-9) continue;
            const rawT = ((queryX - from.x) * dx + (queryZ - from.z) * dz) / lengthSq;
            const t = Math.max(0, Math.min(1, rawT));
            const x = from.x + dx * t;
            const z = from.z + dz * t;
            const distanceSq = (queryX - x) ** 2 + (queryZ - z) ** 2;
            if (nearest && distanceSq >= nearest.distanceSq) continue;
            nearest = {
                route,
                segmentIndex,
                t,
                distanceSq,
                chainageM: route.chainagesM[segmentIndex]
                    + (route.chainagesM[segmentIndex + 1]
                        - route.chainagesM[segmentIndex]) * t,
            };
        }
    }
    if (!nearest) return null;
    const distanceM = Math.sqrt(nearest.distanceSq);
    if (distanceM > Math.max(0, finite(maxSnapDistanceM, Infinity))) return null;

    const point = samplePreparedStationTrackRoute(nearest.route, nearest.chainageM);
    const tangent = tangentAt(
        nearest.route,
        nearest.chainageM,
        tangentHalfSpanM,
        nearest.segmentIndex,
    );
    if (!tangent) return null;
    return {
        ...point,
        ...tangent,
        angleY: Math.atan2(tangent.alongX, tangent.alongZ),
        distanceM,
        route: nearest.route,
    };
}
