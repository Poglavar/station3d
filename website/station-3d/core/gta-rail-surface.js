// Builds the bounded Rapier floor for the exact tram trackbed rendered by rails.js.
// Keeping this as a pure geometry transform makes the render/physics contract testable.

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function endpointJoin(segment, endpoint) {
    const prefix = endpoint === 'start' ? 'start' : 'end';
    const x = Number(segment?.[`${prefix}JoinX`]);
    const z = Number(segment?.[`${prefix}JoinZ`]);
    if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) > 1e-6) {
        return { x, z };
    }
    const dx = Number(segment?.x2) - Number(segment?.x1);
    const dz = Number(segment?.z2) - Number(segment?.z1);
    const length = Math.hypot(dx, dz);
    return length > 1e-6 ? { x: dz / length, z: -dx / length } : null;
}

function pointSegmentDistanceSq(px, pz, segment) {
    const dx = segment.x2 - segment.x1;
    const dz = segment.z2 - segment.z1;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= 1e-12) {
        return (px - segment.x1) ** 2 + (pz - segment.z1) ** 2;
    }
    const t = Math.max(0, Math.min(1,
        ((px - segment.x1) * dx + (pz - segment.z1) * dz) / lengthSq));
    const x = segment.x1 + dx * t;
    const z = segment.z1 + dz * t;
    return (px - x) ** 2 + (pz - z) ** 2;
}

function validSegment(segment) {
    return finite(Number(segment?.x1))
        && finite(Number(segment?.z1))
        && finite(Number(segment?.x2))
        && finite(Number(segment?.z2))
        && finite(Number(segment?.yStart))
        && finite(Number(segment?.yEnd))
        && Number(segment?.startTrackbedHalfWidthM) > 0
        && Number(segment?.endTrackbedHalfWidthM) > 0
        && endpointJoin(segment, 'start')
        && endpointJoin(segment, 'end');
}

function addQuad(vertices, indices, corners) {
    const base = vertices.length / 3;
    for (const corner of corners) vertices.push(corner.x, corner.y, corner.z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function localPoint(x, y, z, toPhysics) {
    const point = toPhysics(x, z);
    return { x: point.x, y, z: point.z };
}

export function buildRailTrackbedTrimeshData({
    segments = [],
    centerX = 0,
    centerZ = 0,
    radiusM = Infinity,
    surfaceOffsetM = 0,
    toPhysics = (x, z) => ({ x, z }),
    maxTriangles = Infinity,
    junctionSteps = 24,
} = {}) {
    const radius = Math.max(0, Number(radiusM) || 0);
    const triangleLimit = Number.isFinite(maxTriangles)
        ? Math.max(0, Math.floor(maxTriangles)) : Infinity;
    const candidates = (Array.isArray(segments) ? segments : [])
        .filter(validSegment)
        .map(segment => {
            const halfWidth = Math.max(
                Number(segment.startTrackbedHalfWidthM),
                Number(segment.endTrackbedHalfWidthM),
            );
            return {
                segment,
                distanceSq: pointSegmentDistanceSq(centerX, centerZ, segment),
                halfWidth,
            };
        })
        .filter(({ distanceSq, halfWidth }) => !Number.isFinite(radiusM)
            || distanceSq <= (radius + halfWidth) ** 2)
        .sort((left, right) => left.distanceSq - right.distanceSq
            || String(left.segment.sortKey || '').localeCompare(
                String(right.segment.sortKey || ''),
            ));

    const vertices = [];
    const indices = [];
    const selected = [];
    let truncated = false;
    for (const { segment } of candidates) {
        // The renderer emits a left and a right strip. They meet at zero inner
        // edge on ordinary track and separate around an island platform.
        if (indices.length / 3 + 4 > triangleLimit) {
            truncated = true;
            break;
        }
        const startJoin = endpointJoin(segment, 'start');
        const endJoin = endpointJoin(segment, 'end');
        const yStart = Number(segment.yStart) + surfaceOffsetM;
        const yEnd = Number(segment.yEnd) + surfaceOffsetM;
        const startInner = Math.max(0, Number(segment.startTrackbedInnerEdgeM) || 0);
        const endInner = Math.max(0, Number(segment.endTrackbedInnerEdgeM) || 0);
        for (const side of [-1, 1]) {
            const startOuterOffset = side * Number(segment.startTrackbedHalfWidthM);
            const endOuterOffset = side * Number(segment.endTrackbedHalfWidthM);
            const startInnerOffset = side * startInner;
            const endInnerOffset = side * endInner;
            const point = (atEnd, offset) => localPoint(
                (atEnd ? segment.x2 : segment.x1)
                    + (atEnd ? endJoin.x : startJoin.x) * offset,
                atEnd ? yEnd : yStart,
                (atEnd ? segment.z2 : segment.z1)
                    + (atEnd ? endJoin.z : startJoin.z) * offset,
                toPhysics,
            );
            addQuad(vertices, indices, side < 0
                ? [
                    point(false, startOuterOffset),
                    point(true, endOuterOffset),
                    point(true, endInnerOffset),
                    point(false, startInnerOffset),
                ]
                : [
                    point(false, startInnerOffset),
                    point(true, endInnerOffset),
                    point(true, endOuterOffset),
                    point(false, startOuterOffset),
                ]);
        }
        selected.push(segment);
    }

    // Match the renderer's circular switch-throat patch. Without it, three or
    // more individually watertight branch strips can still leave a small fan-
    // shaped hole at their shared node.
    const incidentsByNode = new Map();
    for (const segment of selected) {
        for (const endpoint of ['start', 'end']) {
            const key = segment[`${endpoint}Key`];
            if (key == null) continue;
            const incidents = incidentsByNode.get(key) || [];
            incidents.push({
                x: endpoint === 'start' ? segment.x1 : segment.x2,
                z: endpoint === 'start' ? segment.z1 : segment.z2,
                y: (endpoint === 'start' ? segment.yStart : segment.yEnd) + surfaceOffsetM,
                halfWidth: Number(segment[`${endpoint}TrackbedHalfWidthM`]),
            });
            incidentsByNode.set(key, incidents);
        }
    }
    const steps = Math.max(3, Math.floor(Number(junctionSteps) || 24));
    let junctionCount = 0;
    for (const incidents of incidentsByNode.values()) {
        if (incidents.length <= 2) continue;
        if (indices.length / 3 + steps > triangleLimit) {
            truncated = true;
            break;
        }
        const center = incidents[0];
        const halfWidth = Math.max(...incidents.map(incident => incident.halfWidth));
        const y = incidents.reduce((sum, incident) => sum + incident.y, 0)
            / incidents.length + 0.0005;
        const base = vertices.length / 3;
        const physicsCenter = localPoint(center.x, y, center.z, toPhysics);
        vertices.push(physicsCenter.x, physicsCenter.y, physicsCenter.z);
        for (let step = 0; step <= steps; step += 1) {
            const angle = (step / steps) * Math.PI * 2;
            const point = localPoint(
                center.x + Math.cos(angle) * halfWidth,
                y,
                center.z + Math.sin(angle) * halfWidth,
                toPhysics,
            );
            vertices.push(point.x, point.y, point.z);
            if (step > 0) indices.push(base, base + step, base + step + 1);
        }
        junctionCount += 1;
    }

    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices),
        segmentCount: selected.length,
        junctionCount,
        triangleCount: indices.length / 3,
        truncated: truncated || selected.length < candidates.length,
    };
}
