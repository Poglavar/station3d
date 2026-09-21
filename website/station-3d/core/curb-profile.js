// Pure curb-offset join policy shared by the streamed curb geometry and its
// headless regressions. Gentle corners use an exact miter; sharp corners expose
// the two segment normals so the renderer can close them with a bounded bevel.

const JOIN_EPSILON = 1e-6;

function segmentNormal(a, b) {
    const dx = Number(b?.x) - Number(a?.x);
    const dz = Number(b?.z) - Number(a?.z);
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= JOIN_EPSILON) return null;
    const normalX = -dz / length;
    const normalZ = dx / length;
    return {
        x: Math.abs(normalX) <= JOIN_EPSILON ? 0 : normalX,
        z: Math.abs(normalZ) <= JOIN_EPSILON ? 0 : normalZ,
    };
}

function endpointJoin(normal) {
    const direction = normal || { x: 0, z: 0 };
    return {
        incoming: { ...direction },
        outgoing: { ...direction },
        beveled: false,
        rawMiterScale: 1,
    };
}

export function computeCurbOffsetJoins(points, {
    closed = false,
    miterLimit = 2,
} = {}) {
    const safePoints = Array.isArray(points) ? points : [];
    const count = safePoints.length;
    const safeLimit = Math.max(1, Number(miterLimit) || 1);

    return safePoints.map((point, index) => {
        const hasPrevious = closed || index > 0;
        const hasNext = closed || index < count - 1;
        const previous = safePoints[(index - 1 + count) % count];
        const next = safePoints[(index + 1) % count];
        const previousNormal = hasPrevious ? segmentNormal(previous, point) : null;
        const nextNormal = hasNext ? segmentNormal(point, next) : null;

        if (!previousNormal || !nextNormal) {
            return endpointJoin(previousNormal || nextNormal);
        }

        let miterX = previousNormal.x + nextNormal.x;
        let miterZ = previousNormal.z + nextNormal.z;
        const miterLength = Math.hypot(miterX, miterZ);
        if (miterLength <= JOIN_EPSILON) {
            return {
                incoming: previousNormal,
                outgoing: nextNormal,
                beveled: true,
                rawMiterScale: Infinity,
            };
        }

        miterX /= miterLength;
        miterZ /= miterLength;
        const denominator = Math.max(
            JOIN_EPSILON,
            miterX * nextNormal.x + miterZ * nextNormal.z,
        );
        const rawMiterScale = 1 / denominator;
        if (rawMiterScale > safeLimit) {
            return {
                incoming: previousNormal,
                outgoing: nextNormal,
                beveled: true,
                rawMiterScale,
            };
        }

        const miter = {
            x: miterX * rawMiterScale,
            z: miterZ * rawMiterScale,
        };
        return {
            incoming: miter,
            outgoing: { ...miter },
            beveled: false,
            rawMiterScale,
        };
    });
}

// One curb cross-section row shared by every longitudinal strip. Keeping the
// terrain landing in the same row as the stone's rear edge guarantees that a
// fallback curb collar starts on the exact curb vertices instead of being an
// independently sampled strip that can reopen the seam it is closing.
export function createCurbProfileRow(point, direction, {
    u = 0,
    bandWidthM,
    rampWidthM,
    curbTopY,
    terrainOverlapM = 0,
} = {}) {
    const x = Number(point?.x);
    const z = Number(point?.z);
    const directionX = Number(direction?.x);
    const directionZ = Number(direction?.z);
    const bandWidth = Number(bandWidthM);
    const rampWidth = Number(rampWidthM);
    const topY = Number(curbTopY);
    const overlap = Math.max(0, Number(terrainOverlapM) || 0);
    const rowU = Number(u) || 0;
    const rearOffset = bandWidth + rampWidth;
    return {
        u: rowU,
        f0: { x, y: 0, z },
        f1: { x, y: topY, z },
        b: {
            x: x + directionX * bandWidth,
            y: topY,
            z: z + directionZ * bandWidth,
        },
        b0: {
            x: x + directionX * bandWidth,
            y: 0,
            z: z + directionZ * bandWidth,
        },
        r: {
            x: x + directionX * rearOffset,
            y: 0,
            z: z + directionZ * rearOffset,
        },
        terrainLanding: {
            x: x + directionX * rearOffset,
            y: -overlap,
            z: z + directionZ * rearOffset,
        },
    };
}
