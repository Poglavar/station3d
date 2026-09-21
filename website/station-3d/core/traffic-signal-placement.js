// Pure placement policy for visual traffic-signal poles. OSM traffic-signal
// nodes commonly sit on a carriageway centreline, so a fixed lateral offset is
// not safe on roads of different widths. Search the actual rendered road union
// and accept only a pole centre whose full clearance is outside every roadbed.

function pointInRing(x, z, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1;
        index < ring.length;
        previous = index, index += 1) {
        const a = ring[index];
        const b = ring[previous];
        if ((a.z > z) === (b.z > z)) continue;
        const xAtZ = ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
        if (x < xAtZ) inside = !inside;
    }
    return inside;
}

function pointSegmentDistanceSq(x, z, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-9) return (x - start.x) ** 2 + (z - start.z) ** 2;
    const t = Math.max(0, Math.min(1,
        ((x - start.x) * dx + (z - start.z) * dz) / lengthSq,
    ));
    const nearestX = start.x + dx * t;
    const nearestZ = start.z + dz * t;
    return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

function pointNearRing(x, z, ring, clearanceSq) {
    for (let index = 0; index < ring.length; index += 1) {
        if (pointSegmentDistanceSq(
            x,
            z,
            ring[index],
            ring[(index + 1) % ring.length],
        ) <= clearanceSq) return true;
    }
    return false;
}

export function pointTouchesTrafficRoadbed(x, z, roadPolygons, clearanceM = 0) {
    const clearanceSq = Math.max(0, Number(clearanceM) || 0) ** 2;
    for (const polygon of roadPolygons || []) {
        const outer = polygon?.outerRing || [];
        if (outer.length < 3) continue;
        const holes = polygon.holeRings || [];
        const insideOuter = pointInRing(x, z, outer);
        const insideHole = holes.some(hole => hole.length >= 3 && pointInRing(x, z, hole));
        if (insideOuter && !insideHole) return true;
        if (pointNearRing(x, z, outer, clearanceSq)) return true;
        if (holes.some(hole => pointNearRing(x, z, hole, clearanceSq))) return true;
    }
    return false;
}

function normalizedDirection(x, z) {
    const length = Math.hypot(x, z) || 1;
    return { x: x / length, z: z / length };
}

export function findTrafficSignalPolePlacement({
    x,
    z,
    bearingDeg,
    roadPolygons,
    clearanceM = 0.4,
    minimumOffsetM = 2,
    maximumOffsetM = 24,
    searchStepM = 0.4,
} = {}) {
    const sourceX = Number(x);
    const sourceZ = Number(z);
    if (!Number.isFinite(sourceX) || !Number.isFinite(sourceZ)) return null;
    if (!Array.isArray(roadPolygons) || roadPolygons.length === 0) return null;

    const bearingRad = (Number(bearingDeg) || 0) * Math.PI / 180;
    const roadX = Math.sin(bearingRad);
    const roadZ = -Math.cos(bearingRad);
    const rightX = roadZ;
    const rightZ = -roadX;
    const clearance = Math.max(0.15, Number(clearanceM) || 0.4);
    if (!pointTouchesTrafficRoadbed(sourceX, sourceZ, roadPolygons, clearance)) {
        return {
            x: sourceX,
            z: sourceZ,
            roadX,
            roadZ,
            yaw: Math.atan2(roadX, roadZ),
            offsetM: 0,
        };
    }

    const directions = [
        normalizedDirection(rightX, rightZ),
        normalizedDirection(-rightX, -rightZ),
        normalizedDirection(rightX + roadX * 0.45, rightZ + roadZ * 0.45),
        normalizedDirection(rightX - roadX * 0.45, rightZ - roadZ * 0.45),
        normalizedDirection(-rightX + roadX * 0.45, -rightZ + roadZ * 0.45),
        normalizedDirection(-rightX - roadX * 0.45, -rightZ - roadZ * 0.45),
    ];
    const minimum = Math.max(clearance, Number(minimumOffsetM) || 0);
    const maximum = Math.max(minimum, Number(maximumOffsetM) || 24);
    const step = Math.max(0.2, Number(searchStepM) || 0.4);
    const candidates = [];
    for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
        const direction = directions[directionIndex];
        for (let distance = minimum; distance <= maximum + 1e-6; distance += step) {
            const candidateX = sourceX + direction.x * distance;
            const candidateZ = sourceZ + direction.z * distance;
            if (pointTouchesTrafficRoadbed(
                candidateX,
                candidateZ,
                roadPolygons,
                clearance,
            )) continue;
            candidates.push({
                x: candidateX,
                z: candidateZ,
                offsetM: distance,
                directionIndex,
            });
            break;
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => (
        left.offsetM - right.offsetM
        || left.directionIndex - right.directionIndex
    ));
    const chosen = candidates[0];
    return {
        x: chosen.x,
        z: chosen.z,
        roadX,
        roadZ,
        yaw: Math.atan2(roadX, roadZ),
        offsetM: chosen.offsetM,
    };
}

export function trafficSignalLampFacePositions(signal, faceOffsetM = 0.17) {
    const offset = Math.max(0, Number(faceOffsetM) || 0);
    const x = Number(signal?.poleX) || 0;
    const z = Number(signal?.poleZ) || 0;
    const roadX = Number(signal?.roadX) || 0;
    const roadZ = Number(signal?.roadZ) || 0;
    return [
        { x: x + roadX * offset, z: z + roadZ * offset },
        { x: x - roadX * offset, z: z - roadZ * offset },
    ];
}
