// Pure geometry for ambient activity on flat roofs. A roof is an elevated
// outer ring with optional holes, fixed obstacles and a mandatory safety
// margin; every spawn, destination and movement chord is checked against that
// same bounded surface.

export const ROOF_ACTIVITY_EDGE_MARGIN_M = 1.25;
export const ROOF_ACTIVITY_MIN_AREA_M2 = 55;
// Ambient roof life is optional decoration. Keep pathological survey rings
// out of its synchronous registration/movement checks; the building itself is
// still rendered and collides normally.
export const ROOF_ACTIVITY_MAX_COMPLEXITY = 256;

function normalizedRing(ring) {
    if (!Array.isArray(ring)) return null;
    const points = [];
    for (const point of ring) {
        const x = Number(point?.x ?? point?.[0]);
        const z = Number(point?.z ?? point?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        const previous = points[points.length - 1];
        if (!previous || Math.hypot(x - previous.x, z - previous.z) > 1e-6) {
            points.push({ x, z });
        }
    }
    if (points.length > 3) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.z - last.z) <= 1e-6) points.pop();
    }
    return points.length >= 3 ? points : null;
}

function ringArea(ring) {
    let area = 0;
    for (let index = 0; index < ring.length; index++) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        area += a.x * b.z - b.x * a.z;
    }
    return area / 2;
}

function* pointInRingSteps(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const a = ring[index];
        const b = ring[previous];
        if ((a.z > z) !== (b.z > z)) {
            const crossingX = a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x);
            if (x < crossingX) inside = !inside;
        }
        yield;
    }
    return inside;
}

function pointInRing(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const a = ring[index];
        const b = ring[previous];
        if ((a.z > z) === (b.z > z)) continue;
        const crossingX = a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x);
        if (x < crossingX) inside = !inside;
    }
    return inside;
}

function* distanceToRingSteps(x, z, ring) {
    let best = Infinity;
    for (let index = 0; index < ring.length; index++) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        const ratio = lengthSq > 0
            ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq))
            : 0;
        const px = a.x + dx * ratio;
        const pz = a.z + dz * ratio;
        best = Math.min(best, Math.hypot(x - px, z - pz));
        yield;
    }
    return best;
}

function distanceToRing(x, z, ring) {
    let best = Infinity;
    for (let index = 0; index < ring.length; index++) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        const ratio = lengthSq > 0
            ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq))
            : 0;
        const px = a.x + dx * ratio;
        const pz = a.z + dz * ratio;
        best = Math.min(best, Math.hypot(x - px, z - pz));
    }
    return best;
}

function normalizedObstacle(obstacle) {
    const x = Number(obstacle?.x);
    const z = Number(obstacle?.z);
    const lengthM = Number(
        obstacle?.outerLengthM ?? obstacle?.lengthM ?? obstacle?.w,
    );
    const widthM = Number(
        obstacle?.outerWidthM ?? obstacle?.widthM ?? obstacle?.d,
    );
    const angle = Number(obstacle?.angle) || 0;
    const clearanceM = Math.max(0, Number(obstacle?.clearanceM) || 0);
    if (![x, z, lengthM, widthM].every(Number.isFinite)
        || !(lengthM > 0) || !(widthM > 0)) return null;
    return { x, z, lengthM, widthM, angle, clearanceM };
}

function pointInObstacle(x, z, obstacle) {
    const dx = x - obstacle.x;
    const dz = z - obstacle.z;
    const cos = Math.cos(obstacle.angle);
    const sin = Math.sin(obstacle.angle);
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    return Math.abs(localX) <= obstacle.lengthM / 2 + obstacle.clearanceM
        && Math.abs(localZ) <= obstacle.widthM / 2 + obstacle.clearanceM;
}

export function* roofActivityPointSafetySteps(surface, x, z) {
    const px = Number(x);
    const pz = Number(z);
    if (!surface?.outer || !Number.isFinite(px) || !Number.isFinite(pz)) return false;
    const margin = Math.max(0, Number(surface.edgeMarginM) || 0);
    if (!(yield* pointInRingSteps(px, pz, surface.outer))) return false;
    if ((yield* distanceToRingSteps(px, pz, surface.outer)) < margin) return false;
    for (const hole of surface.holes || []) {
        if (yield* pointInRingSteps(px, pz, hole)) return false;
        if ((yield* distanceToRingSteps(px, pz, hole)) < margin) return false;
    }
    for (const obstacle of surface.obstacles || []) {
        const blocked = pointInObstacle(px, pz, obstacle);
        yield;
        if (blocked) return false;
    }
    return true;
}

export function roofActivityPointIsSafe(surface, x, z) {
    const px = Number(x);
    const pz = Number(z);
    if (!surface?.outer || !Number.isFinite(px) || !Number.isFinite(pz)) return false;
    const margin = Math.max(0, Number(surface.edgeMarginM) || 0);
    if (!pointInRing(px, pz, surface.outer)) return false;
    if (distanceToRing(px, pz, surface.outer) < margin) return false;
    for (const hole of surface.holes || []) {
        if (pointInRing(px, pz, hole) || distanceToRing(px, pz, hole) < margin) return false;
    }
    for (const obstacle of surface.obstacles || []) {
        if (pointInObstacle(px, pz, obstacle)) return false;
    }
    return true;
}

function findSeedPoint(surface) {
    const centerX = (surface.minX + surface.maxX) * 0.5;
    const centerZ = (surface.minZ + surface.maxZ) * 0.5;
    if (roofActivityPointIsSafe(surface, centerX, centerZ)) return { x: centerX, z: centerZ };
    const cells = 9;
    for (let zIndex = 0; zIndex < cells; zIndex++) {
        for (let xIndex = 0; xIndex < cells; xIndex++) {
            const x = surface.minX + ((xIndex + 0.5) / cells) * (surface.maxX - surface.minX);
            const z = surface.minZ + ((zIndex + 0.5) / cells) * (surface.maxZ - surface.minZ);
            if (roofActivityPointIsSafe(surface, x, z)) return { x, z };
        }
    }
    return null;
}

export function createRoofActivitySurface({
    id,
    ownerId,
    rings,
    floorY,
    edgeMarginM = ROOF_ACTIVITY_EDGE_MARGIN_M,
    obstacles = [],
} = {}) {
    const outer = normalizedRing(rings?.[0]);
    const y = Number(floorY);
    if (!id || !outer || !Number.isFinite(y)) return null;
    const holes = [];
    for (const ring of rings.slice(1)) {
        const hole = normalizedRing(ring);
        if (hole) holes.push(hole);
    }
    const outerArea = Math.abs(ringArea(outer));
    const holesArea = holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0);
    const areaM2 = Math.max(0, outerArea - holesArea);
    const normalizedObstacles = [];
    for (const obstacle of obstacles || []) {
        const normalized = normalizedObstacle(obstacle);
        if (normalized) normalizedObstacles.push(normalized);
    }
    const complexity = outer.length
        + holes.reduce((sum, hole) => sum + hole.length, 0)
        + normalizedObstacles.length;
    if (complexity > ROOF_ACTIVITY_MAX_COMPLEXITY) return null;
    const obstacleAreaM2 = normalizedObstacles.reduce(
        (sum, obstacle) => sum
            + (obstacle.lengthM + obstacle.clearanceM * 2)
                * (obstacle.widthM + obstacle.clearanceM * 2),
        0,
    );
    const usableAreaM2 = Math.max(0, areaM2 - obstacleAreaM2);
    if (usableAreaM2 < ROOF_ACTIVITY_MIN_AREA_M2) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const point of outer) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    const surface = {
        id: String(id),
        ownerId: String(ownerId ?? id),
        outer,
        holes,
        obstacles: normalizedObstacles,
        floorY: y,
        edgeMarginM: Math.max(0.6, Number(edgeMarginM) || ROOF_ACTIVITY_EDGE_MARGIN_M),
        areaM2,
        obstacleAreaM2,
        usableAreaM2,
        minX,
        maxX,
        minZ,
        maxZ,
        complexity,
    };
    surface.seedPoint = findSeedPoint(surface);
    return surface.seedPoint ? surface : null;
}

export function* roofActivitySegmentSafetySteps(surface, start, end, maxStepM = 0.5) {
    const ax = Number(start?.x);
    const az = Number(start?.z);
    const bx = Number(end?.x);
    const bz = Number(end?.z);
    if (![ax, az, bx, bz].every(Number.isFinite)) return false;
    const distance = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.2, Number(maxStepM) || 0.5)));
    for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        if (!(yield* roofActivityPointSafetySteps(
            surface,
            ax + (bx - ax) * ratio,
            az + (bz - az) * ratio,
        ))) return false;
    }
    return true;
}

export function roofActivitySegmentIsSafe(surface, start, end, maxStepM = 0.5) {
    const ax = Number(start?.x);
    const az = Number(start?.z);
    const bx = Number(end?.x);
    const bz = Number(end?.z);
    if (![ax, az, bx, bz].every(Number.isFinite)) return false;
    const distance = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.2, Number(maxStepM) || 0.5)));
    for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        if (!roofActivityPointIsSafe(
            surface,
            ax + (bx - ax) * ratio,
            az + (bz - az) * ratio,
        )) return false;
    }
    return true;
}

export function* sampleRoofActivityPointSteps(surface, random = Math.random, attempts = 40) {
    if (!surface?.seedPoint || typeof random !== 'function') return null;
    const count = Math.max(1, Math.round(Number(attempts) || 40));
    for (let attempt = 0; attempt < count; attempt++) {
        const unitX = Math.max(0, Math.min(0.999999, Number(random()) || 0));
        const unitZ = Math.max(0, Math.min(0.999999, Number(random()) || 0));
        const x = surface.minX + unitX * (surface.maxX - surface.minX);
        const z = surface.minZ + unitZ * (surface.maxZ - surface.minZ);
        if (yield* roofActivityPointSafetySteps(surface, x, z)) return { x, z };
    }
    return { ...surface.seedPoint };
}

export function sampleRoofActivityPoint(surface, random = Math.random, attempts = 40) {
    if (!surface?.seedPoint || typeof random !== 'function') return null;
    const count = Math.max(1, Math.round(Number(attempts) || 40));
    for (let attempt = 0; attempt < count; attempt++) {
        const unitX = Math.max(0, Math.min(0.999999, Number(random()) || 0));
        const unitZ = Math.max(0, Math.min(0.999999, Number(random()) || 0));
        const x = surface.minX + unitX * (surface.maxX - surface.minX);
        const z = surface.minZ + unitZ * (surface.maxZ - surface.minZ);
        if (roofActivityPointIsSafe(surface, x, z)) return { x, z };
    }
    return { ...surface.seedPoint };
}

// Destination selection is intentionally resumable. A candidate may require
// thousands of edge probes once chord samples and courtyard rings multiply;
// callers can advance this iterator under one global per-frame budget and only
// publish its final result after the whole safety proof succeeds.
export function* roofActivityTargetSearchSteps(surface, start, {
    random = Math.random,
    targetAttempts = 12,
    sampleAttempts = 40,
    minDistanceM = 2.5,
    maxDistanceM = 28,
    maxStepM = 0.5,
} = {}) {
    const count = Math.max(1, Math.round(Number(targetAttempts) || 12));
    for (let attempt = 0; attempt < count; attempt++) {
        const target = yield* sampleRoofActivityPointSteps(surface, random, sampleAttempts);
        if (!target) return null;
        const distance = Math.hypot(target.x - start.x, target.z - start.z);
        if (distance < minDistanceM || distance > maxDistanceM) continue;
        if (!(yield* roofActivitySegmentSafetySteps(surface, start, target, maxStepM))) continue;
        return target;
    }
    return null;
}

export function roofActivityFigureCapacity(surface) {
    const area = Math.max(0, Number(surface?.usableAreaM2 ?? surface?.areaM2) || 0);
    if (area < ROOF_ACTIVITY_MIN_AREA_M2) return 0;
    return Math.max(1, Math.min(3, Math.floor(area / 160)));
}
