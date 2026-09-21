// Deterministic, world-grid-aligned candidate placement for sparse natural
// ground detail. Rendering layers apply geodata exclusions afterwards; this
// module deliberately stays pure so movement cannot reshuffle visible props.

function mixUint32(value) {
    let hash = value >>> 0;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function cellHash(cellX, cellZ, seed, stream = 0) {
    const x = Math.imul(cellX | 0, 0x1f123bb5);
    const z = Math.imul(cellZ | 0, 0x5f356495);
    return mixUint32((seed >>> 0) ^ x ^ z ^ Math.imul(stream | 0, 0x9e3779b1));
}

function unit(cellX, cellZ, seed, stream) {
    return cellHash(cellX, cellZ, seed, stream) / 0x100000000;
}

function seededUnit(seed, stream) {
    return mixUint32((seed >>> 0) ^ Math.imul((stream | 0) + 1, 0x9e3779b1)) / 0x100000000;
}

export function naturalGroundMaterialStyle(kind, lod = 'near') {
    if (kind === 'limestone') {
        return {
            colorHex: 0xe6e3da,
            emissiveHex: 0x77746b,
            emissiveIntensity: 0.20,
            roughness: 0.98,
        };
    }
    return {
        colorHex: lod === 'near' ? 0x647b3e : 0x536b35,
        emissiveHex: 0x334522,
        emissiveIntensity: 0.12,
        roughness: 0.91,
    };
}

// A Dalmatian limestone exposure is a buried cluster, never one complete
// round rock balanced on the terrain. The renderer samples terrain below each
// returned piece and sinks these broad, shallow forms so only their weathered
// caps remain visible.
export function buildLimestoneOutcropPieces(candidate) {
    if (!candidate || candidate.kind !== 'outcrop') return [];
    const seed = Number(candidate.clusterSeed) >>> 0;
    const baseScale = Math.max(0.35, Number(candidate.scale) || 1);
    const boulderCount = 2 + Math.floor(seededUnit(seed, 0) * 2);
    const stoneCount = 6 + Math.floor(seededUnit(seed, 1) * 5);
    const pieces = [];

    for (let index = 0; index < boulderCount + stoneCount; index++) {
        const boulder = index < boulderCount;
        const angle = seededUnit(seed, 10 + index * 9) * Math.PI * 2;
        const radialM = index === 0
            ? seededUnit(seed, 11) * 0.14
            : boulder
                ? 0.28 + seededUnit(seed, 11 + index * 9) * 0.62
                : 0.55 + seededUnit(seed, 11 + index * 9) * 2.05;
        const sizeM = boulder
            ? baseScale * (index === 0
                ? 0.56 + seededUnit(seed, 12 + index * 9) * 0.22
                : 0.34 + seededUnit(seed, 12 + index * 9) * 0.20)
            : baseScale * (0.10 + seededUnit(seed, 12 + index * 9) * 0.15);
        const broadness = 1.02 + seededUnit(seed, 13 + index * 9) * 0.62;
        const depth = 0.88 + seededUnit(seed, 14 + index * 9) * 0.52;
        const heightRatio = boulder
            ? 0.25 + seededUnit(seed, 15 + index * 9) * 0.15
            : 0.22 + seededUnit(seed, 15 + index * 9) * 0.14;
        pieces.push({
            id: `${candidate.id}:${index}`,
            pieceKind: boulder ? 'boulder' : 'stone',
            x: Number(candidate.x) + Math.cos(angle) * radialM,
            z: Number(candidate.z) + Math.sin(angle) * radialM,
            scaleX: sizeM * broadness,
            scaleY: sizeM * heightRatio,
            scaleZ: sizeM * depth,
            embedRatio: 0.48 + seededUnit(seed, 16 + index * 9) * 0.18,
            rotationY: seededUnit(seed, 17 + index * 9) * Math.PI * 2,
            tiltX: (seededUnit(seed, 18 + index * 9) - 0.5) * 0.24,
            tiltZ: (seededUnit(seed, 19 + index * 9) - 0.5) * 0.24,
            tint: seededUnit(seed, 20 + index * 9),
        });
    }
    return pieces;
}

export function buildNaturalScatterCandidates(centerX, centerZ, {
    radiusM = 650,
    cellSizeM = 18,
    density = 0.30,
    seed = 0x51a17,
} = {}) {
    const safeCenterX = Number(centerX) || 0;
    const safeCenterZ = Number(centerZ) || 0;
    const safeRadius = Math.max(1, Number(radiusM) || 650);
    const safeCellSize = Math.max(2, Number(cellSizeM) || 18);
    const safeDensity = Math.max(0, Math.min(1, Number(density) || 0));
    const radiusSq = safeRadius * safeRadius;
    const minCellX = Math.floor((safeCenterX - safeRadius) / safeCellSize);
    const maxCellX = Math.floor((safeCenterX + safeRadius) / safeCellSize);
    const minCellZ = Math.floor((safeCenterZ - safeRadius) / safeCellSize);
    const maxCellZ = Math.floor((safeCenterZ + safeRadius) / safeCellSize);
    const candidates = [];

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            if (unit(cellX, cellZ, seed, 0) >= safeDensity) continue;
            // Keep jitter away from cell edges. This leaves natural breathing
            // room and avoids accidental pairs where neighbouring cells both
            // choose their shared boundary.
            const x = (cellX + 0.16 + unit(cellX, cellZ, seed, 1) * 0.68) * safeCellSize;
            const z = (cellZ + 0.16 + unit(cellX, cellZ, seed, 2) * 0.68) * safeCellSize;
            const dx = x - safeCenterX;
            const dz = z - safeCenterZ;
            const distanceSq = dx * dx + dz * dz;
            if (distanceSq > radiusSq) continue;

            const kindUnit = unit(cellX, cellZ, seed, 3);
            const kind = kindUnit < 0.72 ? 'shrub' : 'outcrop';
            const shape = unit(cellX, cellZ, seed, 4);
            const distanceM = Math.sqrt(distanceSq);
            // The far ring keeps only the strongest silhouettes. This is a
            // deterministic density LOD: it cuts triangle count without a
            // per-frame object walk or visible reshuffle during small moves.
            if (distanceM > safeRadius * 0.68 && shape > 0.46) continue;
            candidates.push({
                id: `${cellX}:${cellZ}`,
                cellX,
                cellZ,
                x,
                z,
                distanceM,
                kind,
                rotationY: unit(cellX, cellZ, seed, 5) * Math.PI * 2,
                scale: kind === 'shrub'
                    ? 0.65 + unit(cellX, cellZ, seed, 6) * 1.35
                    : 0.65 + unit(cellX, cellZ, seed, 6) * 0.80,
                aspect: 0.72 + unit(cellX, cellZ, seed, 7) * 0.62,
                tint: unit(cellX, cellZ, seed, 8),
                clusterSeed: cellHash(cellX, cellZ, seed, 9),
                lod: distanceM <= safeRadius * 0.38 ? 'near' : 'far',
            });
        }
    }
    return candidates;
}
