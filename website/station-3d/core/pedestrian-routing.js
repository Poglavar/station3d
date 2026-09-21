// Pure 2D routing helpers that keep ambient pedestrians outside streamed
// building footprints while allowing destinations at exterior door points.

const EPSILON = 1e-6;
// A detailed survey outline can carry hundreds of facade segments. Building a
// visibility graph from every endpoint is superlinear and used to charge
// 100--500 ms to a single ambient walker. Past this point, route around the
// conservative rendered bounds instead: four nodes, with every candidate leg
// still checked against the exact walls below.
const MAX_EXACT_DETOUR_SEGMENTS = 24;

function cross(ax, az, bx, bz) {
    return ax * bz - az * bx;
}

function segmentIntersectionParameter(start, end, wall) {
    const rx = end.x - start.x;
    const rz = end.z - start.z;
    const sx = wall.bx - wall.ax;
    const sz = wall.bz - wall.az;
    const qx = wall.ax - start.x;
    const qz = wall.az - start.z;
    const denominator = cross(rx, rz, sx, sz);
    if (Math.abs(denominator) <= EPSILON) {
        if (Math.abs(cross(qx, qz, rx, rz)) > EPSILON) return null;
        const lengthSq = rx * rx + rz * rz;
        if (lengthSq <= EPSILON) return null;
        const t0 = (qx * rx + qz * rz) / lengthSq;
        const t1 = t0 + (sx * rx + sz * rz) / lengthSq;
        const overlapStart = Math.max(EPSILON, Math.min(t0, t1));
        const overlapEnd = Math.min(1 - EPSILON, Math.max(t0, t1));
        return overlapStart <= overlapEnd ? overlapStart : null;
    }
    const t = cross(qx, qz, sx, sz) / denominator;
    const u = cross(qx, qz, rx, rz) / denominator;
    return t > EPSILON && t < 1 - EPSILON && u >= -EPSILON && u <= 1 + EPSILON
        ? t
        : null;
}

function footprintMayMeetSegment(start, end, footprint) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minZ = Math.min(start.z, end.z);
    const maxZ = Math.max(start.z, end.z);
    return footprint.maxX >= minX && footprint.minX <= maxX
        && footprint.maxZ >= minZ && footprint.minZ <= maxZ;
}

export function pointInBuildingFootprint(point, footprint) {
    if (!footprint || !Array.isArray(footprint.segments)) return false;
    if (footprint.closed === false) return false;
    if (point.x < footprint.minX || point.x > footprint.maxX
        || point.z < footprint.minZ || point.z > footprint.maxZ) return false;
    let crossings = 0;
    for (const wall of footprint.segments) {
        const azAbove = wall.az > point.z;
        const bzAbove = wall.bz > point.z;
        if (azAbove === bzAbove) continue;
        const x = wall.ax + (point.z - wall.az) * (wall.bx - wall.ax) / (wall.bz - wall.az);
        if (x > point.x) crossings++;
    }
    return crossings % 2 === 1;
}

export function firstFootprintCrossing(start, end, footprints) {
    let nearest = null;
    for (const footprint of footprints || []) {
        if (!footprintMayMeetSegment(start, end, footprint)) continue;
        for (const wall of footprint.segments || []) {
            const t = segmentIntersectionParameter(start, end, wall);
            if (t == null || (nearest && nearest.t <= t)) continue;
            nearest = { footprint, wall, t };
        }
    }
    return nearest;
}

export function routeCrossesBuildingFootprints(start, route, footprints) {
    let from = start;
    for (const point of route || []) {
        if (firstFootprintCrossing(from, point, footprints)) return true;
        from = point;
    }
    return false;
}

export function movementCrossesBuildingFootprints(start, end, footprints) {
    if (firstFootprintCrossing(start, end, footprints)) return true;
    return (footprints || []).some(footprint => pointInBuildingFootprint(end, footprint));
}

export function footprintMatchesRenderedBounds(detailed, authoritative, toleranceM = 3) {
    const rendered = detailed && detailed.renderedBounds ? detailed.renderedBounds : detailed;
    if (!rendered || !authoritative) return false;
    const keys = ['minX', 'maxX', 'minZ', 'maxZ'];
    if (!keys.every(key => Number.isFinite(rendered[key]) && Number.isFinite(authoritative[key]))) return false;
    const tolerance = Math.max(0, Number(toleranceM) || 0);
    return keys.every(key => Math.abs(rendered[key] - authoritative[key]) <= tolerance);
}

function detourCandidates(footprint, clearanceM) {
    if ((footprint?.segments?.length || 0) > MAX_EXACT_DETOUR_SEGMENTS) {
        const minX = Number(footprint?.minX);
        const maxX = Number(footprint?.maxX);
        const minZ = Number(footprint?.minZ);
        const maxZ = Number(footprint?.maxZ);
        if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return [];
        return [
            { x: minX - clearanceM, z: minZ - clearanceM },
            { x: maxX + clearanceM, z: minZ - clearanceM },
            { x: maxX + clearanceM, z: maxZ + clearanceM },
            { x: minX - clearanceM, z: maxZ + clearanceM },
        ];
    }
    const candidates = [];
    const seen = new Set();
    for (const wall of footprint.segments || []) {
        const dx = wall.bx - wall.ax;
        const dz = wall.bz - wall.az;
        const length = Math.hypot(dx, dz);
        if (length <= EPSILON) continue;
        const tx = dx / length;
        const tz = dz / length;
        const nx = Number.isFinite(wall.normalX) ? wall.normalX : -tz;
        const nz = Number.isFinite(wall.normalZ) ? wall.normalZ : tx;
        for (const point of [
            { x: wall.ax + nx * clearanceM - tx * clearanceM, z: wall.az + nz * clearanceM - tz * clearanceM },
            { x: wall.bx + nx * clearanceM + tx * clearanceM, z: wall.bz + nz * clearanceM + tz * clearanceM },
        ]) {
            const key = `${Math.round(point.x * 20)}:${Math.round(point.z * 20)}`;
            if (seen.has(key) || pointInBuildingFootprint(point, footprint)) continue;
            seen.add(key);
            candidates.push(point);
        }
    }
    return candidates;
}

function shortestVisibleDetour(start, end, footprint, clearanceM) {
    const nodes = [start, end, ...detourCandidates(footprint, clearanceM)];
    const distances = new Array(nodes.length).fill(Infinity);
    const previous = new Array(nodes.length).fill(-1);
    const visited = new Array(nodes.length).fill(false);
    distances[0] = 0;

    for (let iteration = 0; iteration < nodes.length; iteration++) {
        let current = -1;
        for (let index = 0; index < nodes.length; index++) {
            if (!visited[index] && (current < 0 || distances[index] < distances[current])) current = index;
        }
        if (current < 0 || !Number.isFinite(distances[current])) break;
        if (current === 1) break;
        visited[current] = true;
        for (let next = 1; next < nodes.length; next++) {
            if (next === current || visited[next]) continue;
            if (firstFootprintCrossing(nodes[current], nodes[next], [footprint])) continue;
            const distance = Math.hypot(nodes[next].x - nodes[current].x, nodes[next].z - nodes[current].z);
            const candidateDistance = distances[current] + distance;
            if (candidateDistance >= distances[next]) continue;
            distances[next] = candidateDistance;
            previous[next] = current;
        }
    }
    if (!Number.isFinite(distances[1])) return null;
    const route = [];
    for (let index = 1; index > 0; index = previous[index]) {
        route.push({ x: nodes[index].x, z: nodes[index].z });
        if (previous[index] < 0) return null;
    }
    return route.reverse();
}

export function planFootprintAwareRoute(start, end, footprints, {
    clearanceM = 0.75,
    maxDetours = 16,
} = {}) {
    const route = [{ x: end.x, z: end.z }];
    for (let iteration = 0; iteration < maxDetours; iteration++) {
        let from = start;
        let crossing = null;
        let segmentIndex = -1;
        for (let index = 0; index < route.length; index++) {
            crossing = firstFootprintCrossing(from, route[index], footprints);
            if (crossing) {
                segmentIndex = index;
                break;
            }
            from = route[index];
        }
        if (!crossing) return route;
        let detour = null;
        for (const multiplier of [1, 1.6, 2.4]) {
            detour = shortestVisibleDetour(
                from,
                route[segmentIndex],
                crossing.footprint,
                clearanceM * multiplier,
            );
            if (detour) break;
        }
        if (!detour) return null;
        route.splice(segmentIndex, 1, ...detour);
    }
    return null;
}
