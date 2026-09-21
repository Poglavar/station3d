// Immutable triangle support index shared by baked terrain, roads and rails.
// It is deliberately independent of Three/Rapier: visible geometry and vehicle
// support are decoded from the same packet primitives and therefore cannot
// arrive at different times or disagree after a pause.

const DEFAULT_CELL_SIZE_M = 16;
const EPSILON = 1e-7;
const FLOAT32_RELATIVE_PRECISION = 2 ** -23;

function coordinateToleranceM(ax, az, bx, bz, cx, cz) {
    // Packet vertices are float32; driving coordinates stay double precision.
    // Permit one storage rounding unit at an edge, measured in metres rather
    // than barycentric units (which stretch with the triangle's dimensions).
    return Math.max(1e-6, FLOAT32_RELATIVE_PRECISION * Math.max(
        Math.abs(ax), Math.abs(az), Math.abs(bx), Math.abs(bz), Math.abs(cx), Math.abs(cz),
    ));
}

function finite(value) {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function cellKey(x, z, cellSizeM) {
    return `${Math.floor(x / cellSizeM)}:${Math.floor(z / cellSizeM)}`;
}

function surfaceClaim(primitive) {
    return primitive?.surfaceClaims?.[0] || null;
}

function claimKind(claim) {
    return String(claim?.surfaceClass || '').toLowerCase();
}

const LEGACY_SUPPORT_CLASSES = new Set([
    'terrain',
    'ground',
    'road',
    'rail',
    'sidewalk',
    'path',
    'platform',
    'building',
]);

function supportKind(claim, kind) {
    // Published packs carry the compiled support capability. Reading it keeps
    // the baked index aligned with canonical classes such as
    // road-carriageway, buffered-sidewalk and rail-trackbed. Legacy fixtures
    // predate that field, so retain their bounded class fallback. Building
    // roofs remain walkable even though the volume claim is not civil ground.
    if (typeof claim?.capabilities?.support === 'boolean') {
        return claim.capabilities.support || kind === 'building';
    }
    return LEGACY_SUPPORT_CLASSES.has(kind);
}

function drivableKind(claim, kind) {
    if (!supportKind(claim, kind) || kind === 'building') return false;
    // Route policy decides where a vehicle should go. Physics must still hold
    // it up on any published non-building support it actually reaches.
    return true;
}

function triangleYAtXZ(primitive, triangleOffset, x, z, offsetX, offsetZ) {
    const { positions, indices } = primitive;
    const ia = indices[triangleOffset] * 3;
    const ib = indices[triangleOffset + 1] * 3;
    const ic = indices[triangleOffset + 2] * 3;
    const ax = positions[ia] + offsetX;
    const ay = positions[ia + 1];
    const az = positions[ia + 2] + offsetZ;
    const bx = positions[ib] + offsetX;
    const by = positions[ib + 1];
    const bz = positions[ib + 2] + offsetZ;
    const cx = positions[ic] + offsetX;
    const cy = positions[ic + 1];
    const cz = positions[ic + 2] + offsetZ;
    const v0x = bx - ax;
    const v0z = bz - az;
    const v1x = cx - ax;
    const v1z = cz - az;
    const v2x = x - ax;
    const v2z = z - az;
    const denominator = v0x * v1z - v1x * v0z;
    if (Math.abs(denominator) <= EPSILON) return null;
    const u = (v2x * v1z - v1x * v2z) / denominator;
    const v = (v0x * v2z - v2x * v0z) / denominator;
    if (u < -EPSILON || v < -EPSILON || u + v > 1 + EPSILON) {
        const tolerance = coordinateToleranceM(
            positions[ia], positions[ia + 2], positions[ib], positions[ib + 2], positions[ic], positions[ic + 2],
        ) / Math.abs(denominator);
        if (u < -EPSILON - tolerance * Math.hypot(v1x, v1z)
            || v < -EPSILON - tolerance * Math.hypot(v0x, v0z)
            || u + v > 1 + EPSILON + tolerance * Math.hypot(v1x - v0x, v1z - v0z)) return null;
    }
    return ay + u * (by - ay) + v * (cy - ay);
}

export function createCampaignPackSupportIndex(packets, {
    cellSizeM = DEFAULT_CELL_SIZE_M,
    offsetX = 0,
    offsetZ = 0,
} = {}) {
    const cell = Math.max(1, finite(cellSizeM) || DEFAULT_CELL_SIZE_M);
    const buckets = new Map();
    const primitives = [];
    let triangleCount = 0;
    let baseTriangleCount = 0;
    for (const packet of packets || []) {
        for (const primitive of packet?.primitives || []) {
            const claim = surfaceClaim(primitive);
            const kind = claimKind(claim);
            if (!supportKind(claim, kind)) continue;
            const positions = primitive.positions;
            const indices = primitive.indices;
            const primitiveIndex = primitives.length;
            primitives.push({
                positions,
                indices,
                kind,
                drivable: drivableKind(claim, kind),
            });
            for (let index = 0; index < indices.length; index += 3) {
                const ia = indices[index] * 3;
                const ib = indices[index + 1] * 3;
                const ic = indices[index + 2] * 3;
                const ax = positions[ia] + offsetX;
                const az = positions[ia + 2] + offsetZ;
                const bx = positions[ib] + offsetX;
                const bz = positions[ib + 2] + offsetZ;
                const cx = positions[ic] + offsetX;
                const cz = positions[ic + 2] + offsetZ;
                const tolerance = coordinateToleranceM(
                    positions[ia], positions[ia + 2], positions[ib], positions[ib + 2], positions[ic], positions[ic + 2],
                );
                const minX = Math.min(ax, bx, cx) - tolerance;
                const maxX = Math.max(ax, bx, cx) + tolerance;
                const minZ = Math.min(az, bz, cz) - tolerance;
                const maxZ = Math.max(az, bz, cz) + tolerance;
                const minCellX = Math.floor(minX / cell);
                const maxCellX = Math.floor(maxX / cell);
                const minCellZ = Math.floor(minZ / cell);
                const maxCellZ = Math.floor(maxZ / cell);
                for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                        const key = `${cellX}:${cellZ}`;
                        let list = buckets.get(key);
                        if (!list) buckets.set(key, list = []);
                        list.push(primitiveIndex, index);
                    }
                }
                triangleCount += 1;
                if (kind === 'terrain' || kind === 'ground') baseTriangleCount += 1;
            }
        }
    }
    // A bucket stores two uints per triangle reference instead of retaining a
    // separate nine-number JS object for every support triangle (and again for
    // every cell it overlaps). The decoded packet buffers already own the
    // positions, so the immutable index only needs primitive + triangle IDs.
    for (const [key, entries] of buckets) buckets.set(key, new Uint32Array(entries));

    const supportYAt = (xValue, zValue, {
        maxY = Infinity,
        drivableOnly = false,
        terrainOnly = false,
        surfaceClasses = null,
        referenceY = null,
    } = {}) => {
        const x = finite(xValue);
        const z = finite(zValue);
        if (x == null || z == null) return null;
        const candidates = buckets.get(cellKey(x, z, cell)) || [];
        let best = -Infinity;
        const nearestLevel = Number.isFinite(referenceY);
        for (let cursor = 0; cursor < candidates.length; cursor += 2) {
            const primitive = primitives[candidates[cursor]];
            if (terrainOnly && primitive.kind !== 'terrain' && primitive.kind !== 'ground') continue;
            if (surfaceClasses && !surfaceClasses.includes(primitive.kind)) continue;
            if (drivableOnly && !primitive.drivable) continue;
            const y = triangleYAtXZ(
                primitive,
                candidates[cursor + 1],
                x,
                z,
                offsetX,
                offsetZ,
            );
            if (y == null || y > maxY + EPSILON) continue;
            if (nearestLevel
                ? Math.abs(y - referenceY) >= Math.abs(best - referenceY)
                : y <= best) continue;
            best = y;
        }
        return best === -Infinity ? null : best;
    };

    return Object.freeze({
        supportYAt,
        terrainYAt: (x, z, options = {}) => supportYAt(x, z, { ...options, terrainOnly: true }),
        snapshot: () => Object.freeze({
            contract: 'station3d-campaign-pack-support-v1',
            cellSizeM: cell,
            bucketCount: buckets.size,
            triangleCount,
            baseTriangleCount,
        }),
    });
}

export function campaignPackSpawnSupportY(support, x, z, {
    maxSurfaceOffsetM = 2,
} = {}) {
    const terrainY = support?.terrainYAt?.(x, z);
    if (!Number.isFinite(terrainY)) {
        const transportY = support?.supportYAt?.(x, z, { drivableOnly: true });
        return Number.isFinite(transportY) ? transportY : null;
    }
    const maxY = terrainY + Math.max(0, finite(maxSurfaceOffsetM) ?? 2);
    const surfaceY = support?.supportYAt?.(x, z, { maxY });
    return Number.isFinite(surfaceY) ? surfaceY : terrainY;
}
