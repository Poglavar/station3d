// Derives immutable building-wall collision data from the same baked triangles
// that are rendered. This keeps old packs physical without adding a parallel
// footprint download or requiring a new archive schema/re-bake.

const DEFAULT_CELL_SIZE_M = 64;
const DEFAULT_MIN_VERTICAL_SPAN_M = 1.8;
const DEFAULT_MAX_NORMAL_Y = 0.35;
const DEFAULT_ENDPOINT_QUANTIZATION_M = 0.1;
const DEFAULT_LINE_ANGLE_QUANTIZATION_RAD = Math.PI / 360;
const DEFAULT_LINE_OFFSET_QUANTIZATION_M = 0.15;
const DEFAULT_LINE_GAP_TOLERANCE_M = 0.25;

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function optionalFinite(value) {
    return value === null || value === undefined ? null : finite(value);
}

function buildingClaim(primitive) {
    const claim = primitive?.surfaceClaims?.[0] || null;
    return String(claim?.surfaceClass || '').toLowerCase() === 'building'
        ? claim
        : null;
}

function endpointKey(x, z, quantum) {
    return `${Math.round(x / quantum)}:${Math.round(z / quantum)}`;
}

function wallKey(a, b, quantum) {
    const keyA = endpointKey(a.x, a.z, quantum);
    const keyB = endpointKey(b.x, b.z, quantum);
    return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
}

function projectedWallEdge(points) {
    const pairs = [[0, 1], [1, 2], [2, 0]];
    let best = null;
    for (const [aIndex, bIndex] of pairs) {
        const a = points[aIndex];
        const b = points[bIndex];
        const lengthSq = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
        if (!best || lengthSq > best.lengthSq) best = { a, b, lengthSq };
    }
    return best;
}

function boundsDistanceSq(x, z, wall) {
    const dx = x < wall.minX ? wall.minX - x : x > wall.maxX ? x - wall.maxX : 0;
    const dz = z < wall.minZ ? wall.minZ - z : z > wall.maxZ ? z - wall.maxZ : 0;
    return dx * dx + dz * dz;
}

function segmentDistanceSq(x, z, wall) {
    const dx = wall.bx - wall.ax;
    const dz = wall.bz - wall.az;
    const lengthSq = dx * dx + dz * dz;
    const ratio = lengthSq > 1e-9
        ? Math.max(0, Math.min(1, ((x - wall.ax) * dx + (z - wall.az) * dz) / lengthSq))
        : 0;
    const nearestX = wall.ax + dx * ratio;
    const nearestZ = wall.az + dz * ratio;
    return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

function bucketKey(x, z, cellSizeM) {
    return `${x}:${z}`;
}

function canonicalLineAngle(dx, dz) {
    let angle = Math.atan2(dz, dx);
    while (angle < -Math.PI * 0.5) angle += Math.PI;
    while (angle >= Math.PI * 0.5) angle -= Math.PI;
    return angle;
}

function mergeCoplanarWallFragments(walls, {
    endpointQuantum,
    angleQuantum = DEFAULT_LINE_ANGLE_QUANTIZATION_RAD,
    offsetQuantum = DEFAULT_LINE_OFFSET_QUANTIZATION_M,
    gapTolerance = DEFAULT_LINE_GAP_TOLERANCE_M,
} = {}) {
    const groups = new Map();
    for (const wall of walls) {
        const dx = wall.bx - wall.ax;
        const dz = wall.bz - wall.az;
        const lengthM = Math.hypot(dx, dz);
        if (lengthM < 1e-6) continue;
        const angleBin = Math.round(canonicalLineAngle(dx, dz) / angleQuantum);
        const angle = angleBin * angleQuantum;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const normalX = -dirZ;
        const normalZ = dirX;
        const midpointX = (wall.ax + wall.bx) * 0.5;
        const midpointZ = (wall.az + wall.bz) * 0.5;
        const offset = midpointX * normalX + midpointZ * normalZ;
        const offsetBin = Math.round(offset / offsetQuantum);
        const groupKey = `${angleBin}:${offsetBin}`;
        let group = groups.get(groupKey);
        if (!group) {
            group = {
                dirX,
                dirZ,
                normalX,
                normalZ,
                weightedOffset: 0,
                totalLength: 0,
                fragments: [],
            };
            groups.set(groupKey, group);
        }
        const tA = wall.ax * dirX + wall.az * dirZ;
        const tB = wall.bx * dirX + wall.bz * dirZ;
        group.weightedOffset += offset * lengthM;
        group.totalLength += lengthM;
        group.fragments.push({
            minT: Math.min(tA, tB),
            maxT: Math.max(tA, tB),
            baseY: wall.baseY,
            topY: wall.topY,
            objectId: wall.objectId,
        });
    }

    const merged = [];
    const publish = (group, fragment) => {
        const offset = group.totalLength > 0
            ? group.weightedOffset / group.totalLength
            : 0;
        const ax = group.dirX * fragment.minT + group.normalX * offset;
        const az = group.dirZ * fragment.minT + group.normalZ * offset;
        const bx = group.dirX * fragment.maxT + group.normalX * offset;
        const bz = group.dirZ * fragment.maxT + group.normalZ * offset;
        merged.push({
            key: wallKey({ x: ax, z: az }, { x: bx, z: bz }, endpointQuantum),
            objectId: fragment.objectId,
            ax,
            az,
            bx,
            bz,
            baseY: fragment.baseY,
            topY: fragment.topY,
            minX: Math.min(ax, bx),
            maxX: Math.max(ax, bx),
            minZ: Math.min(az, bz),
            maxZ: Math.max(az, bz),
        });
    };

    for (const group of groups.values()) {
        group.fragments.sort((a, b) => a.minT - b.minT || a.maxT - b.maxT);
        let current = null;
        for (const fragment of group.fragments) {
            if (!current || fragment.minT > current.maxT + gapTolerance) {
                if (current) publish(group, current);
                current = { ...fragment };
                continue;
            }
            current.maxT = Math.max(current.maxT, fragment.maxT);
            current.baseY = Math.min(current.baseY, fragment.baseY);
            current.topY = Math.max(current.topY, fragment.topY);
        }
        if (current) publish(group, current);
    }
    return merged.sort((a, b) => a.key.localeCompare(b.key));
}

export function createCampaignPackBuildingCollisionIndex(packets, {
    cellSizeM = DEFAULT_CELL_SIZE_M,
    offsetX = 0,
    offsetZ = 0,
    minVerticalSpanM = DEFAULT_MIN_VERTICAL_SPAN_M,
    maxNormalY = DEFAULT_MAX_NORMAL_Y,
    endpointQuantizationM = DEFAULT_ENDPOINT_QUANTIZATION_M,
} = {}) {
    const cell = Math.max(8, finite(cellSizeM) || DEFAULT_CELL_SIZE_M);
    const minimumSpan = Math.max(0.25, finite(minVerticalSpanM)
        || DEFAULT_MIN_VERTICAL_SPAN_M);
    const normalYLimit = Math.max(0, Math.min(1, finite(maxNormalY)
        ?? DEFAULT_MAX_NORMAL_Y));
    const quantum = Math.max(0.01, finite(endpointQuantizationM)
        || DEFAULT_ENDPOINT_QUANTIZATION_M);
    const byWallKey = new Map();
    let buildingTriangleCount = 0;

    for (const packet of packets || []) {
        for (const primitive of packet?.primitives || []) {
            const claim = buildingClaim(primitive);
            if (!claim) continue;
            const positions = primitive.positions;
            const indices = primitive.indices;
            if (!positions || !indices) continue;
            for (let index = 0; index + 2 < indices.length; index += 3) {
                const points = [indices[index], indices[index + 1], indices[index + 2]].map(
                    vertexIndex => ({
                        x: positions[vertexIndex * 3] + offsetX,
                        y: positions[vertexIndex * 3 + 1],
                        z: positions[vertexIndex * 3 + 2] + offsetZ,
                    }),
                );
                if (!points.every(point => [point.x, point.y, point.z].every(Number.isFinite))) {
                    continue;
                }
                buildingTriangleCount += 1;
                const [a, b, c] = points;
                const ux = b.x - a.x;
                const uy = b.y - a.y;
                const uz = b.z - a.z;
                const vx = c.x - a.x;
                const vy = c.y - a.y;
                const vz = c.z - a.z;
                const nx = uy * vz - uz * vy;
                const ny = uz * vx - ux * vz;
                const nz = ux * vy - uy * vx;
                const normalLength = Math.hypot(nx, ny, nz);
                if (normalLength < 1e-8 || Math.abs(ny) / normalLength > normalYLimit) continue;
                const baseY = Math.min(a.y, b.y, c.y);
                const topY = Math.max(a.y, b.y, c.y);
                if (topY - baseY < minimumSpan) continue;
                const edge = projectedWallEdge(points);
                if (!edge || edge.lengthSq < 0.15 ** 2) continue;
                const key = wallKey(edge.a, edge.b, quantum);
                const existing = byWallKey.get(key);
                if (existing) {
                    existing.baseY = Math.min(existing.baseY, baseY);
                    existing.topY = Math.max(existing.topY, topY);
                    continue;
                }
                const ax = edge.a.x;
                const az = edge.a.z;
                const bx = edge.b.x;
                const bz = edge.b.z;
                byWallKey.set(key, {
                    key,
                    objectId: claim.ownerId || claim.featureId || claim.replacementKey || key,
                    ax,
                    az,
                    bx,
                    bz,
                    baseY,
                    topY,
                    minX: Math.min(ax, bx),
                    maxX: Math.max(ax, bx),
                    minZ: Math.min(az, bz),
                    maxZ: Math.max(az, bz),
                });
            }
        }
    }

    // Facade meshes are commonly split around windows and repeated by detail
    // layers. Their coplanar triangles must form one physical wall, otherwise
    // a car can contact hundreds of coincident boxes and become wedged.
    const walls = mergeCoplanarWallFragments([...byWallKey.values()], {
        endpointQuantum: quantum,
    });
    const buckets = new Map();
    for (const wall of walls) {
        const minCellX = Math.floor(wall.minX / cell);
        const maxCellX = Math.floor(wall.maxX / cell);
        const minCellZ = Math.floor(wall.minZ / cell);
        const maxCellZ = Math.floor(wall.maxZ / cell);
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                const key = bucketKey(cellX, cellZ, cell);
                let bucket = buckets.get(key);
                if (!bucket) buckets.set(key, bucket = []);
                bucket.push(wall);
            }
        }
    }

    const wallsNear = (xValue, zValue, radiusValue = 60) => {
        const x = finite(xValue);
        const z = finite(zValue);
        if (x === null || z === null) return [];
        const radius = Math.max(0, finite(radiusValue) || 0);
        const radiusSq = radius * radius;
        const candidates = new Set();
        for (let cellX = Math.floor((x - radius) / cell);
            cellX <= Math.floor((x + radius) / cell); cellX++) {
            for (let cellZ = Math.floor((z - radius) / cell);
                cellZ <= Math.floor((z + radius) / cell); cellZ++) {
                for (const wall of buckets.get(bucketKey(cellX, cellZ, cell)) || []) {
                    candidates.add(wall);
                }
            }
        }
        return [...candidates].filter(wall => boundsDistanceSq(x, z, wall) <= radiusSq);
    };

    const footprintsNear = (xValue, zValue, radiusValue = 60, verticalRange = null) => {
        const x = finite(xValue);
        const z = finite(zValue);
        if (x === null || z === null) return [];
        const minY = optionalFinite(verticalRange?.minY);
        const maxY = optionalFinite(verticalRange?.maxY);
        return wallsNear(x, z, radiusValue)
            .filter(wall => (minY === null || wall.topY > minY)
                && (maxY === null || wall.baseY < maxY))
            .map(wall => ({ wall, distanceSq: segmentDistanceSq(x, z, wall) }))
            .sort((a, b) => a.distanceSq - b.distanceSq || a.wall.key.localeCompare(b.wall.key))
            .map(({ wall }) => ({
                objectId: wall.objectId,
                source: 'campaign-pack',
                closed: false,
                minX: wall.minX,
                maxX: wall.maxX,
                minZ: wall.minZ,
                maxZ: wall.maxZ,
                baseY: wall.baseY,
                topY: wall.topY,
                segments: [{
                    ax: wall.ax,
                    az: wall.az,
                    bx: wall.bx,
                    bz: wall.bz,
                    baseY: wall.baseY,
                    topY: wall.topY,
                }],
            }));
    };

    const colliderSpecsNear = (xValue, zValue, radiusValue, maxCollidersValue, {
        wallThicknessM = 0.45,
        minY: minYValue = null,
        maxY: maxYValue = null,
    } = {}) => {
        const x = finite(xValue);
        const z = finite(zValue);
        if (x === null || z === null) return [];
        const radius = Math.max(0, finite(radiusValue) || 0);
        const radiusSq = radius * radius;
        const limit = Math.max(0, Math.trunc(finite(maxCollidersValue) || 0));
        const halfThickness = Math.max(0.05, finite(wallThicknessM) || 0.45) * 0.5;
        const minY = optionalFinite(minYValue);
        const maxY = optionalFinite(maxYValue);
        return wallsNear(x, z, radius)
            .filter(wall => (minY === null || wall.topY > minY)
                && (maxY === null || wall.baseY < maxY))
            .map(wall => ({ wall, distanceSq: segmentDistanceSq(x, z, wall) }))
            .filter(entry => entry.distanceSq <= radiusSq)
            .sort((a, b) => a.distanceSq - b.distanceSq
                || a.wall.key.localeCompare(b.wall.key))
            .slice(0, limit)
            .map(({ wall, distanceSq }) => {
                const dx = wall.bx - wall.ax;
                const dz = wall.bz - wall.az;
                const lengthM = Math.hypot(dx, dz);
                const heightM = wall.topY - wall.baseY;
                return {
                    id: `building:campaign-pack:${wall.key}`,
                    kind: 'building',
                    x: (wall.ax + wall.bx) * 0.5,
                    y: wall.baseY + heightM * 0.5,
                    z: (wall.az + wall.bz) * 0.5,
                    halfX: lengthM * 0.5,
                    halfY: heightM * 0.5,
                    halfZ: halfThickness,
                    yaw: -Math.atan2(dz, dx),
                    distanceSq,
                    destructive: false,
                };
            });
    };

    return Object.freeze({
        colliderSpecsNear,
        footprintsNear,
        snapshot: () => Object.freeze({
            contract: 'station3d-campaign-pack-building-collision-v1',
            cellSizeM: cell,
            buildingTriangleCount,
            wallCount: walls.length,
            bucketCount: buckets.size,
        }),
    });
}
