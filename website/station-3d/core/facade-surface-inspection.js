// Browser-independent facade face diagnostics retained by the general scene
// inspector. The scan is restricted to the picked entity range when geometry
// has been merged, so inspecting one building never walks a city-wide batch.

const NORMAL_QUANT = 0.05;
const PLANE_D_QUANT = 0.10;
const NORMAL_PARALLEL_DOT = 0.95;
const NEAR_D_GAP_M = 1.0;
const MAX_SCANNED_TRIANGLES = 120_000;
const MAX_REPORTED_TRIANGLES = 32;
const MAX_HIGHLIGHT_TRIANGLES = 2_000;

function quantizedPlaneKey(nx, ny, nz, d) {
    const qx = Math.round(nx / NORMAL_QUANT) * NORMAL_QUANT;
    const qy = Math.round(ny / NORMAL_QUANT) * NORMAL_QUANT;
    const qz = Math.round(nz / NORMAL_QUANT) * NORMAL_QUANT;
    const qd = Math.round(d / PLANE_D_QUANT) * PLANE_D_QUANT;
    return `${qx.toFixed(2)}|${qy.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(1)}`;
}

function readTriangle(geometry, triangleIndex) {
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.getIndex?.();
    if (!position) return null;
    const first = triangleIndex * 3;
    const vertexAt = drawIndex => (index ? index.getX(drawIndex) : drawIndex);
    const vertices = [];
    for (let corner = 0; corner < 3; corner++) {
        const vertex = vertexAt(first + corner);
        if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) return null;
        vertices.push([
            position.getX(vertex),
            position.getY(vertex),
            position.getZ(vertex),
        ]);
    }
    return vertices;
}

function trianglePlane(vertices) {
    if (!vertices) return null;
    const [v0, v1, v2] = vertices;
    const e1x = v1[0] - v0[0];
    const e1y = v1[1] - v0[1];
    const e1z = v1[2] - v0[2];
    const e2x = v2[0] - v0[0];
    const e2y = v2[1] - v0[1];
    const e2z = v2[2] - v0[2];
    const crossX = e1y * e2z - e1z * e2y;
    const crossY = e1z * e2x - e1x * e2z;
    const crossZ = e1x * e2y - e1y * e2x;
    const length = Math.hypot(crossX, crossY, crossZ);
    if (length < 1e-6) return null;
    const nx = crossX / length;
    const ny = crossY / length;
    const nz = crossZ / length;
    return {
        nx,
        ny,
        nz,
        d: nx * v0[0] + ny * v0[1] + nz * v0[2],
    };
}

function drawnTriangleCount(geometry) {
    const position = geometry?.getAttribute?.('position');
    if (!position) return 0;
    return Math.floor((geometry.getIndex?.()?.count ?? position.count) / 3);
}

function scanBounds(totalTriangles, range) {
    if (!range) return { start: 0, end: totalTriangles };
    const start = Math.max(0, Math.floor(Number(range.start) / 3));
    const end = Math.min(
        totalTriangles,
        Math.ceil((Number(range.start) + Number(range.count)) / 3),
    );
    return { start, end };
}

export function analyzeFacadeSurfaceGeometry(geometry, faceIndex, { range = null } = {}) {
    const totalTriangles = drawnTriangleCount(geometry);
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= totalTriangles) {
        return { status: 'unavailable', reason: 'face index is outside the rendered geometry' };
    }
    const bounds = scanBounds(totalTriangles, range);
    const scannedTriangleCount = Math.max(0, bounds.end - bounds.start);
    if (faceIndex < bounds.start || faceIndex >= bounds.end) {
        return { status: 'unavailable', reason: 'face index is outside the owning entity range' };
    }
    if (scannedTriangleCount > MAX_SCANNED_TRIANGLES) {
        return {
            status: 'skipped',
            reason: `entity range has ${scannedTriangleCount} triangles (scan cap ${MAX_SCANNED_TRIANGLES})`,
            meshTriangleCount: totalTriangles,
            scannedTriangleCount,
            hitTriangleIndex: faceIndex,
        };
    }

    const hitVertices = readTriangle(geometry, faceIndex);
    const plane = trianglePlane(hitVertices);
    if (!plane) return { status: 'unavailable', reason: 'hit triangle is degenerate' };
    const bucketKey = quantizedPlaneKey(plane.nx, plane.ny, plane.nz, plane.d);
    const sameBucketTriangleIndices = [];
    const highlightTriangles = [hitVertices];
    const nearCoplanarSample = [];
    let sameBucketCount = 0;
    let nearCoplanarCount = 0;
    let oppositeCloseCount = 0;
    let sameSideJitterCount = 0;

    for (let triangleIndex = bounds.start; triangleIndex < bounds.end; triangleIndex++) {
        if (triangleIndex === faceIndex) continue;
        const vertices = readTriangle(geometry, triangleIndex);
        const candidate = trianglePlane(vertices);
        if (!candidate) continue;
        const candidateKey = quantizedPlaneKey(
            candidate.nx,
            candidate.ny,
            candidate.nz,
            candidate.d,
        );
        if (candidateKey === bucketKey) {
            sameBucketCount += 1;
            if (sameBucketTriangleIndices.length < MAX_REPORTED_TRIANGLES) {
                sameBucketTriangleIndices.push(triangleIndex);
            }
            if (highlightTriangles.length < MAX_HIGHLIGHT_TRIANGLES) {
                highlightTriangles.push(vertices);
            }
            continue;
        }
        const dot = plane.nx * candidate.nx + plane.ny * candidate.ny + plane.nz * candidate.nz;
        if (Math.abs(dot) < NORMAL_PARALLEL_DOT) continue;
        const first = vertices[0];
        const alongHitNormal = plane.nx * first[0] + plane.ny * first[1] + plane.nz * first[2];
        const distanceGapM = Math.abs(alongHitNormal - plane.d);
        if (distanceGapM > NEAR_D_GAP_M) continue;
        nearCoplanarCount += 1;
        if (dot < 0 && distanceGapM < 0.5) oppositeCloseCount += 1;
        if (dot > 0 && distanceGapM < 0.2) sameSideJitterCount += 1;
        if (nearCoplanarSample.length < MAX_REPORTED_TRIANGLES) {
            nearCoplanarSample.push({
                triangleIndex,
                normalDot: Number(dot.toFixed(4)),
                distanceGapM: Number(distanceGapM.toFixed(4)),
                sameSide: dot > 0,
                bucketKey: candidateKey,
            });
        }
    }

    return {
        status: 'analysed',
        meshTriangleCount: totalTriangles,
        scannedTriangleCount,
        scanTriangleRange: [bounds.start, Math.max(bounds.start, bounds.end - 1)],
        hitTriangleIndex: faceIndex,
        plane: {
            normal: {
                x: Number(plane.nx.toFixed(5)),
                y: Number(plane.ny.toFixed(5)),
                z: Number(plane.nz.toFixed(5)),
            },
            offsetD: Number(plane.d.toFixed(5)),
        },
        bucketKey,
        recoveredFaceTriangleCount: sameBucketCount + 1,
        sameBucketTriangleIndices,
        nearCoplanarCount,
        nearCoplanarSample,
        probableThickWallPairs: oppositeCloseCount,
        probableBucketFragmentation: sameSideJitterCount,
        highlightTriangles,
        highlightTruncated: sameBucketCount + 1 > MAX_HIGHLIGHT_TRIANGLES,
    };
}
