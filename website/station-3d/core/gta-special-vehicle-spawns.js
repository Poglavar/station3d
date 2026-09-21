// Pure spawn selection for the bounded GTA boat and aircraft layer. It turns
// loaded water/runway evidence into deterministic local-world candidates.

function finitePoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

export function pointInLocalRing(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = (ring || []).length - 1;
        index < (ring || []).length;
        previous = index, index += 1) {
        const a = ring[index];
        const b = ring[previous];
        if (!finitePoint(a) || !finitePoint(b)) continue;
        const crosses = (a.z > z) !== (b.z > z)
            && x < (b.x - a.x) * (z - a.z) / ((b.z - a.z) || Number.EPSILON) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

export function runwaySpawnCandidates(entries, { toLocal } = {}) {
    if (typeof toLocal !== 'function') return [];
    const candidates = [];
    for (let entryIndex = 0; entryIndex < (entries || []).length; entryIndex += 1) {
        const entry = entries[entryIndex];
        if (entry?.aeroway !== 'runway') continue;
        const coordinates = entry?.rings?.[0];
        if (!Array.isArray(coordinates) || coordinates.length < 4) continue;
        const ring = coordinates
            .map(([lon, lat]) => toLocal(Number(lon), Number(lat)))
            .filter(finitePoint);
        if (ring.length < 4) continue;
        const openRing = ring.length > 1
            && Math.hypot(ring[0].x - ring.at(-1).x, ring[0].z - ring.at(-1).z) < 0.01
            ? ring.slice(0, -1) : ring;
        if (openRing.length < 3) continue;
        let longest = null;
        for (let index = 0; index < openRing.length; index += 1) {
            const from = openRing[index];
            const to = openRing[(index + 1) % openRing.length];
            const lengthM = Math.hypot(to.x - from.x, to.z - from.z);
            if (!longest || lengthM > longest.lengthM) longest = { from, to, lengthM };
        }
        if (!longest || longest.lengthM < 30) continue;
        const x = openRing.reduce((sum, point) => sum + point.x, 0) / openRing.length;
        const z = openRing.reduce((sum, point) => sum + point.z, 0) / openRing.length;
        candidates.push({
            id: `runway:${entry.sourceId || entryIndex}`,
            x,
            z,
            heading: Math.atan2(longest.to.x - longest.from.x, longest.to.z - longest.from.z),
            lengthM: longest.lengthM,
            ring: openRing,
        });
    }
    return candidates;
}

// Which side of a runway's centreline a point is on: +1 to the right of the
// runway heading, -1 to the left (never 0, so a spot is always chosen).
export function runwaySide(candidate, x, z) {
    const px = Math.cos(candidate.heading);
    const pz = -Math.sin(candidate.heading);
    const dot = (x - candidate.x) * px + (z - candidate.z) * pz;
    return dot < 0 ? -1 : 1;
}

// A row of parking spots beside a runway on one side: noses along the
// runway, clear of the paved strip by `clearanceM`, `spacingM` apart and
// centred on the runway's midpoint. Ids carry the side so a row approached
// from the other side later is a different row, never a moved aircraft.
export function runwayParkingSpots(candidate, { count = 3, spacingM = 12, clearanceM = 10, side = 1 } = {}) {
    const ring = candidate?.ring;
    if (!Array.isArray(ring) || ring.length < 3 || !Number.isFinite(candidate.heading)) return [];
    const ax = Math.sin(candidate.heading);
    const az = Math.cos(candidate.heading);
    const px = Math.cos(candidate.heading);
    const pz = -Math.sin(candidate.heading);
    let halfWidthM = 0;
    for (const point of ring) {
        if (!finitePoint(point)) continue;
        halfWidthM = Math.max(halfWidthM, Math.abs((point.x - candidate.x) * px + (point.z - candidate.z) * pz));
    }
    const which = side < 0 ? -1 : 1;
    const offsetM = (halfWidthM + clearanceM) * which;
    const spots = [];
    for (let index = 0; index < Math.max(0, Math.trunc(count)); index += 1) {
        const alongM = (index - (count - 1) / 2) * spacingM;
        spots.push({
            id: `${candidate.id}:park:${which > 0 ? 'r' : 'l'}:${index}`,
            x: candidate.x + ax * alongM + px * offsetM,
            z: candidate.z + az * alongM + pz * offsetM,
            heading: candidate.heading,
            runwayId: candidate.id,
        });
    }
    return spots;
}

export function nearestRunwayCandidate(candidates, x, z, maxDistanceM = Infinity) {
    let best = null;
    for (const candidate of candidates || []) {
        const distanceM = Math.hypot(candidate.x - x, candidate.z - z);
        if (distanceM > maxDistanceM || (best && distanceM >= best.distanceM)) continue;
        best = { ...candidate, distanceM };
    }
    return best;
}

export function findNearestWaterSpawn({
    x,
    z,
    isWaterAt,
    minRadiusM = 8,
    maxRadiusM = 260,
    radiusStepM = 8,
    directionCount = 32,
} = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || typeof isWaterAt !== 'function') return null;
    if (isWaterAt(x, z)) return { x, z, distanceM: 0, heading: 0 };
    const directions = Math.max(8, Math.trunc(directionCount));
    for (let radius = Math.max(0, minRadiusM); radius <= maxRadiusM; radius += radiusStepM) {
        for (let index = 0; index < directions; index += 1) {
            const angle = index * Math.PI * 2 / directions;
            const candidateX = x + Math.sin(angle) * radius;
            const candidateZ = z + Math.cos(angle) * radius;
            if (!isWaterAt(candidateX, candidateZ)) continue;
            return {
                x: candidateX,
                z: candidateZ,
                distanceM: radius,
                heading: angle + Math.PI / 2,
            };
        }
    }
    return null;
}

// Converts stable geographic moorings into nearby local-world candidates,
// accepting only points confirmed by the water geometry currently streamed.
export function mappedBoatSpawnCandidates(anchors, {
    x,
    z,
    toLocal,
    isWaterAt,
    maxDistanceM = Infinity,
} = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)
        || typeof toLocal !== 'function' || typeof isWaterAt !== 'function') return [];
    const candidates = [];
    for (const anchor of anchors || []) {
        const lat = Number(anchor?.lat);
        const lon = Number(anchor?.lon);
        if (!anchor?.id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const local = toLocal(lon, lat);
        if (!finitePoint(local) || !isWaterAt(local.x, local.z)) continue;
        const distanceM = Math.hypot(local.x - x, local.z - z);
        if (distanceM > maxDistanceM) continue;
        candidates.push({
            id: String(anchor.id),
            x: local.x,
            z: local.z,
            heading: Number.isFinite(anchor.heading) ? anchor.heading : 0,
            distanceM,
            // An authored name reaches the boarding prompt ("E · Ukrcaj se: …").
            ...(anchor.label ? { label: anchor.label } : {}),
        });
    }
    return candidates.sort((left, right) => left.distanceM - right.distanceM);
}
