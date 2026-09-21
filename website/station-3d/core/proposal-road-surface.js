// Builds bounded, shared-station proposal-road surface data so every material
// follows one longitudinal grade without independently triangulated crossings.

export const PROPOSAL_ROAD_RENDER_CHUNK_M = 96;
export const PROPOSAL_ROAD_STATION_SPACING_M = 4;
export const PROPOSAL_ROAD_JUNCTION_RADIAL_STEP_M = 2;
export const PROPOSAL_ROAD_JUNCTION_BOUNDARY_STEP_M = 2;
export const PROPOSAL_ROAD_COAST_MIN_APRON_M = 1.65;
// Ordinary road formation reaches at most 1.5 m from its paved edge. Only a
// mapped shoreline inside that civil band authorizes the closure; a real beach
// or wider natural foreshore must remain terrain, not become accidental quay.
export const PROPOSAL_ROAD_COAST_SEARCH_M = 1.5;
export const PROPOSAL_ROAD_COAST_WATER_OVERLAP_M = 0.3;
export const PROPOSAL_ROAD_COAST_SUBMERGENCE_M = 0.45;

const MIN_POINT_SEPARATION_M = 1e-5;

function finitePoint(point) {
    const x = Number(point?.x);
    const z = Number(point?.z);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

function cleanLine(points) {
    const line = [];
    for (const input of Array.isArray(points) ? points : []) {
        const point = finitePoint(input);
        if (!point) continue;
        const previous = line[line.length - 1];
        if (previous && Math.hypot(point.x - previous.x, point.z - previous.z)
            <= MIN_POINT_SEPARATION_M) continue;
        line.push(point);
    }
    return line;
}

function lineCumulativeDistances(line) {
    const cumulative = [0];
    for (let index = 1; index < line.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(
            line[index].x - line[index - 1].x,
            line[index].z - line[index - 1].z,
        ));
    }
    return cumulative;
}

function pointAtDistance(line, cumulative, distanceM) {
    const totalM = cumulative[cumulative.length - 1];
    const distance = Math.max(0, Math.min(totalM, Number(distanceM) || 0));
    let low = 0;
    let high = cumulative.length - 2;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (distance <= cumulative[middle + 1]) high = middle;
        else low = middle + 1;
    }
    const index = low;
    const spanM = cumulative[index + 1] - cumulative[index];
    const t = spanM > MIN_POINT_SEPARATION_M
        ? (distance - cumulative[index]) / spanM
        : 0;
    return {
        x: line[index].x + (line[index + 1].x - line[index].x) * t,
        z: line[index].z + (line[index + 1].z - line[index].z) * t,
    };
}

function stationAtDistance(line, cumulative, distanceM, tangentSampleM) {
    const totalM = cumulative[cumulative.length - 1];
    const point = pointAtDistance(line, cumulative, distanceM);
    const halfSampleM = Math.max(0.25, tangentSampleM / 2);
    let before = pointAtDistance(line, cumulative, distanceM - halfSampleM);
    let after = pointAtDistance(line, cumulative, distanceM + halfSampleM);
    let dx = after.x - before.x;
    let dz = after.z - before.z;
    let length = Math.hypot(dx, dz);
    if (length <= MIN_POINT_SEPARATION_M) {
        before = pointAtDistance(line, cumulative, Math.max(0, distanceM - 1));
        after = pointAtDistance(line, cumulative, Math.min(totalM, distanceM + 1));
        dx = after.x - before.x;
        dz = after.z - before.z;
        length = Math.hypot(dx, dz);
    }
    if (length <= MIN_POINT_SEPARATION_M) return null;
    return {
        chainageM: distanceM,
        x: point.x,
        z: point.z,
        // Local Z points south, so (dz, -dx) is left of travel.
        normalX: dz / length,
        normalZ: -dx / length,
    };
}

export function buildProposalRoadStationChunks(localLine, {
    chunkLengthM = PROPOSAL_ROAD_RENDER_CHUNK_M,
    stationSpacingM = PROPOSAL_ROAD_STATION_SPACING_M,
} = {}) {
    const line = cleanLine(localLine);
    if (line.length < 2) return [];
    const cumulative = lineCumulativeDistances(line);
    const totalM = cumulative[cumulative.length - 1];
    if (!(totalM > MIN_POINT_SEPARATION_M)) return [];
    const safeChunkM = Math.max(8, Number(chunkLengthM) || PROPOSAL_ROAD_RENDER_CHUNK_M);
    const safeSpacingM = Math.max(0.5,
        Math.min(safeChunkM, Number(stationSpacingM) || PROPOSAL_ROAD_STATION_SPACING_M));
    const chunkCount = Math.max(1, Math.ceil(totalM / safeChunkM));
    const chunks = [];
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const startChainageM = Math.min(totalM, chunkIndex * safeChunkM);
        const endChainageM = chunkIndex === chunkCount - 1
            ? totalM
            : Math.min(totalM, (chunkIndex + 1) * safeChunkM);
        const lengthM = endChainageM - startChainageM;
        const intervalCount = Math.max(1, Math.ceil(lengthM / safeSpacingM));
        const stations = [];
        for (let interval = 0; interval <= intervalCount; interval += 1) {
            const chainageM = interval === intervalCount
                ? endChainageM
                : startChainageM + lengthM * interval / intervalCount;
            const station = stationAtDistance(line, cumulative, chainageM, safeSpacingM);
            if (station) stations.push(station);
        }
        if (stations.length < 2) continue;
        chunks.push({
            index: chunkIndex,
            startChainageM,
            endChainageM,
            lengthM,
            isLineStart: chunkIndex === 0,
            isLineEnd: chunkIndex === chunkCount - 1,
            stations,
        });
    }
    return chunks;
}

function checkedBaseSceneYs(stations, baseSceneYs) {
    if (!Array.isArray(baseSceneYs) || baseSceneYs.length !== stations.length) {
        throw new Error('proposal-road station/base-height count mismatch');
    }
    return baseSceneYs.map((value) => {
        const sceneY = Number(value);
        if (!Number.isFinite(sceneY)) {
            throw new Error('proposal-road station has no finite designed height');
        }
        return sceneY;
    });
}

function checkedOffsets(offsets) {
    const values = (Array.isArray(offsets) ? offsets : []).map(Number);
    if (values.length < 2 || values.some(value => !Number.isFinite(value))) {
        throw new Error('proposal-road surface needs at least two finite offsets');
    }
    return values;
}

function stationPoint(station, offsetM, sceneY) {
    return {
        x: station.x + station.normalX * offsetM,
        y: sceneY,
        z: station.z + station.normalZ * offsetM,
    };
}

// A junction is a small bounded radial grid, not one triangulated perimeter.
// The center sample pins the shared topology-node elevation and the radial
// samples follow each incident formation as ownership changes around the
// apron. This prevents a steep intersection from becoming one floating plane.
export function buildProposalRoadJunctionGeometryData({
    centerX,
    centerZ,
    boundary,
    surfaceYAtLocal,
    surfaceOffsetY = 0,
    radialStepM = PROPOSAL_ROAD_JUNCTION_RADIAL_STEP_M,
    boundaryStepM = PROPOSAL_ROAD_JUNCTION_BOUNDARY_STEP_M,
} = {}) {
    const x = Number(centerX);
    const z = Number(centerZ);
    const lift = Number(surfaceOffsetY);
    const sourceBoundary = (Array.isArray(boundary) ? boundary : [])
        .map(finitePoint)
        .filter(Boolean);
    if (sourceBoundary.length > 1
        && Math.hypot(
            sourceBoundary[0].x - sourceBoundary[sourceBoundary.length - 1].x,
            sourceBoundary[0].z - sourceBoundary[sourceBoundary.length - 1].z,
        ) <= MIN_POINT_SEPARATION_M) sourceBoundary.pop();
    if (![x, z, lift].every(Number.isFinite)
        || sourceBoundary.length < 3
        || typeof surfaceYAtLocal !== 'function') return null;
    const edgeLengths = sourceBoundary.map((point, index) => {
        const next = sourceBoundary[(index + 1) % sourceBoundary.length];
        return Math.hypot(next.x - point.x, next.z - point.z);
    });
    const perimeterM = edgeLengths.reduce((sum, length) => sum + length, 0);
    if (!(perimeterM > MIN_POINT_SEPARATION_M)) return null;
    const safeBoundaryStepM = Math.max(
        0.75,
        Number(boundaryStepM) || 0,
        perimeterM / 128,
    );
    const sampledBoundary = [];
    for (let edgeIndex = 0; edgeIndex < sourceBoundary.length; edgeIndex += 1) {
        const point = sourceBoundary[edgeIndex];
        const next = sourceBoundary[(edgeIndex + 1) % sourceBoundary.length];
        const intervalCount = Math.max(1, Math.ceil(edgeLengths[edgeIndex] / safeBoundaryStepM));
        for (let interval = 0; interval < intervalCount; interval += 1) {
            const t = interval / intervalCount;
            sampledBoundary.push({
                x: point.x + (next.x - point.x) * t,
                z: point.z + (next.z - point.z) * t,
            });
        }
    }
    const radius = sampledBoundary.reduce((maximum, point) => Math.max(
        maximum,
        Math.hypot(point.x - x, point.z - z),
    ), 0);
    if (!(radius > MIN_POINT_SEPARATION_M)) return null;
    const safeRadialStepM = Math.max(0.75, Number(radialStepM) || 0);
    const radialRingCount = Math.max(1, Math.min(16, Math.ceil(radius / safeRadialStepM)));
    const boundaryVertexCount = sampledBoundary.length;
    const vertexCount = 1 + radialRingCount * boundaryVertexCount;
    const positions = new Float32Array(vertexCount * 3);
    const setVertex = (index, pointX, pointZ) => {
        const baseY = Number(surfaceYAtLocal(pointX, pointZ));
        if (!Number.isFinite(baseY)) {
            throw new Error('proposal-road junction has no finite designed height');
        }
        positions[index * 3] = pointX;
        positions[index * 3 + 1] = baseY + lift;
        positions[index * 3 + 2] = pointZ;
    };
    setVertex(0, x, z);
    for (let ringIndex = 0; ringIndex < radialRingCount; ringIndex += 1) {
        const scale = (ringIndex + 1) / radialRingCount;
        for (let boundaryIndex = 0; boundaryIndex < boundaryVertexCount; boundaryIndex += 1) {
            const point = sampledBoundary[boundaryIndex];
            setVertex(
                1 + ringIndex * boundaryVertexCount + boundaryIndex,
                x + (point.x - x) * scale,
                z + (point.z - z) * scale,
            );
        }
    }
    const triangleCount = boundaryVertexCount
        + Math.max(0, radialRingCount - 1) * boundaryVertexCount * 2;
    const indices = new Uint32Array(triangleCount * 3);
    let cursor = 0;
    for (let boundaryIndex = 0; boundaryIndex < boundaryVertexCount; boundaryIndex += 1) {
        const nextBoundaryIndex = (boundaryIndex + 1) % boundaryVertexCount;
        indices[cursor++] = 0;
        indices[cursor++] = 1 + boundaryIndex;
        indices[cursor++] = 1 + nextBoundaryIndex;
    }
    for (let ringIndex = 1; ringIndex < radialRingCount; ringIndex += 1) {
        const innerBase = 1 + (ringIndex - 1) * boundaryVertexCount;
        const outerBase = 1 + ringIndex * boundaryVertexCount;
        for (let boundaryIndex = 0; boundaryIndex < boundaryVertexCount; boundaryIndex += 1) {
            const nextBoundaryIndex = (boundaryIndex + 1) % boundaryVertexCount;
            const inner = innerBase + boundaryIndex;
            const innerNext = innerBase + nextBoundaryIndex;
            const outer = outerBase + boundaryIndex;
            const outerNext = outerBase + nextBoundaryIndex;
            indices[cursor++] = inner;
            indices[cursor++] = outer;
            indices[cursor++] = outerNext;
            indices[cursor++] = inner;
            indices[cursor++] = outerNext;
            indices[cursor++] = innerNext;
        }
    }
    return { positions, indices, radialRingCount, boundaryVertexCount };
}

function interpolatedStation(a, b) {
    let normalX = (a.normalX + b.normalX) * 0.5;
    let normalZ = (a.normalZ + b.normalZ) * 0.5;
    const normalLength = Math.hypot(normalX, normalZ);
    if (normalLength > MIN_POINT_SEPARATION_M) {
        normalX /= normalLength;
        normalZ /= normalLength;
    } else {
        normalX = a.normalX;
        normalZ = a.normalZ;
    }
    return {
        x: (a.x + b.x) * 0.5,
        z: (a.z + b.z) * 0.5,
        normalX,
        normalZ,
    };
}

function mappedSeaDistanceFromEdge(
    station,
    edgeOffsetM,
    outsideDirection,
    isMappedSeaAtLocal,
    searchM,
) {
    const inSea = (distanceM) => {
        const offset = edgeOffsetM + outsideDirection * distanceM;
        const point = stationPoint(station, offset, 0);
        return isMappedSeaAtLocal(point.x, point.z) === true;
    };
    if (inSea(0)) return 0;
    const probes = [0.75, 1.5, 2.5, 3.5, searchM]
        .filter((distance, index, values) => (
            distance <= searchM && (index === 0 || distance > values[index - 1])
        ));
    let landDistance = 0;
    for (const probeDistance of probes) {
        if (!inSea(probeDistance)) {
            landDistance = probeDistance;
            continue;
        }
        let low = landDistance;
        let high = probeDistance;
        // The vector shoreline is the authority. Four bisections put the
        // concrete/water handoff within centimetres without walking a polygon
        // query every few centimetres along a multi-kilometre proposal.
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const middle = (low + high) * 0.5;
            if (inSea(middle)) high = middle;
            else low = middle;
        }
        return high;
    }
    return null;
}

function appendTriangle(positions, a, b, c) {
    for (const point of [a, b, c]) positions.push(point.x, point.y, point.z);
}

function appendSurfaceQuad(positions, a, b, c, d) {
    appendTriangle(positions, a, c, b);
    appendTriangle(positions, a, d, c);
}

// A coastal proposal is a small reclamation/retaining work, not a road slab
// suspended over a raster NoData fringe. This builds a bounded concrete apron
// from the exact outer cross-section vertex across the civil band's nearby
// mapped shoreline, then drops its outside face below the shared sea surface. Both neighbouring
// render chunks consume the same station object, so their top and wall seams
// are byte-identical.
export function buildProposalRoadCoastalClosureGeometryData(
    chunk,
    edgeOffsetM,
    outsideDirection,
    baseSceneYs,
    surfaceOffsetY,
    {
        isMappedSeaAtLocal,
        seaSceneY,
        minimumApronM = PROPOSAL_ROAD_COAST_MIN_APRON_M,
        shorelineSearchM = PROPOSAL_ROAD_COAST_SEARCH_M,
        waterOverlapM = PROPOSAL_ROAD_COAST_WATER_OVERLAP_M,
        submergenceM = PROPOSAL_ROAD_COAST_SUBMERGENCE_M,
    } = {},
) {
    const stations = Array.isArray(chunk?.stations) ? chunk.stations : [];
    if (stations.length < 2 || typeof isMappedSeaAtLocal !== 'function') return null;
    const edgeOffset = Number(edgeOffsetM);
    const direction = Math.sign(Number(outsideDirection));
    const surfaceLift = Number(surfaceOffsetY);
    const waterY = Number(seaSceneY);
    if (![edgeOffset, surfaceLift, waterY].every(Number.isFinite) || direction === 0) return null;
    const baseYs = checkedBaseSceneYs(stations, baseSceneYs);
    const searchM = Math.max(0, Number(shorelineSearchM) || 0);
    const minApronM = Math.max(0.1, Number(minimumApronM) || 0);
    const overlapM = Math.max(0, Number(waterOverlapM) || 0);
    const submergedM = Math.max(0.05, Number(submergenceM) || 0);
    const stationWidths = stations.map((station) => {
        const coastDistance = mappedSeaDistanceFromEdge(
            station,
            edgeOffset,
            direction,
            isMappedSeaAtLocal,
            searchM,
        );
        return coastDistance === null
            ? null
            : Math.max(minApronM, coastDistance + overlapM);
    });
    const intervalWidths = [];
    for (let index = 0; index < stations.length - 1; index += 1) {
        let widthA = stationWidths[index];
        let widthB = stationWidths[index + 1];
        if (widthA === null && widthB === null) {
            const middle = interpolatedStation(stations[index], stations[index + 1]);
            const middleDistance = mappedSeaDistanceFromEdge(
                middle,
                edgeOffset,
                direction,
                isMappedSeaAtLocal,
                searchM,
            );
            if (middleDistance === null) {
                intervalWidths.push(null);
                continue;
            }
            widthA = widthB = Math.max(minApronM, middleDistance + overlapM);
        } else if (widthA === null) {
            widthA = widthB;
        } else if (widthB === null) {
            widthB = widthA;
        }
        intervalWidths.push([widthA, widthB]);
    }
    if (!intervalWidths.some(Boolean)) return null;

    const positions = [];
    const edgeTopPoints = new Float32Array(stations.length * 3);
    for (let index = 0; index < stations.length; index += 1) {
        const edge = stationPoint(
            stations[index],
            edgeOffset,
            baseYs[index] + surfaceLift,
        );
        edgeTopPoints[index * 3] = edge.x;
        edgeTopPoints[index * 3 + 1] = edge.y;
        edgeTopPoints[index * 3 + 2] = edge.z;
    }
    const point = (stationIndex, offset, y) => stationPoint(
        stations[stationIndex],
        offset,
        y,
    );
    const appendEndCap = (stationIndex, widthM, topY, bottomY, reverse = false) => {
        const innerTop = point(stationIndex, edgeOffset, topY);
        const outerTop = point(stationIndex, edgeOffset + direction * widthM, topY);
        const outerBottom = point(stationIndex, edgeOffset + direction * widthM, bottomY);
        const innerBottom = point(stationIndex, edgeOffset, bottomY);
        if (reverse) appendSurfaceQuad(positions, innerTop, innerBottom, outerBottom, outerTop);
        else appendSurfaceQuad(positions, innerTop, outerTop, outerBottom, innerBottom);
    };
    for (let index = 0; index < intervalWidths.length; index += 1) {
        const widths = intervalWidths[index];
        if (!widths) continue;
        const [widthA, widthB] = widths;
        const topAY = baseYs[index] + surfaceLift;
        const topBY = baseYs[index + 1] + surfaceLift;
        const bottomAY = Math.min(waterY - submergedM, topAY - 0.2);
        const bottomBY = Math.min(waterY - submergedM, topBY - 0.2);
        const innerA = point(index, edgeOffset, topAY);
        const innerB = point(index + 1, edgeOffset, topBY);
        const outerA = point(index, edgeOffset + direction * widthA, topAY);
        const outerB = point(index + 1, edgeOffset + direction * widthB, topBY);
        const bottomA = point(index, edgeOffset + direction * widthA, bottomAY);
        const bottomB = point(index + 1, edgeOffset + direction * widthB, bottomBY);
        appendSurfaceQuad(positions, innerA, innerB, outerB, outerA);
        appendSurfaceQuad(positions, outerA, outerB, bottomB, bottomA);

        const previousActive = index > 0 && intervalWidths[index - 1] !== null;
        const nextActive = index + 1 < intervalWidths.length
            && intervalWidths[index + 1] !== null;
        if (!previousActive
            && ((chunk.isLineStart && chunk.junctionStart !== true) || index > 0)) {
            appendEndCap(index, widthA, topAY, bottomAY);
        }
        if (!nextActive
            && ((chunk.isLineEnd && chunk.junctionEnd !== true)
                || index + 1 < intervalWidths.length)) {
            appendEndCap(index + 1, widthB, topBY, bottomBY, true);
        }
    }
    return {
        positions: new Float32Array(positions),
        edgeTopPoints,
        stationWidths,
        intervalWidths,
    };
}

export function buildProposalRoadSurfaceGeometryData(
    chunk,
    offsets,
    baseSceneYs,
    surfaceOffsetY = 0,
) {
    const stations = Array.isArray(chunk?.stations) ? chunk.stations : [];
    if (stations.length < 2) return null;
    const crossSectionOffsets = checkedOffsets(offsets);
    const baseYs = checkedBaseSceneYs(stations, baseSceneYs);
    const lift = Number(surfaceOffsetY);
    if (!Number.isFinite(lift)) throw new Error('proposal-road surface lift must be finite');
    const positions = new Float32Array(stations.length * crossSectionOffsets.length * 3);
    for (let stationIndex = 0; stationIndex < stations.length; stationIndex += 1) {
        for (let offsetIndex = 0; offsetIndex < crossSectionOffsets.length; offsetIndex += 1) {
            const vertexIndex = stationIndex * crossSectionOffsets.length + offsetIndex;
            const point = stationPoint(
                stations[stationIndex],
                crossSectionOffsets[offsetIndex],
                baseYs[stationIndex] + lift,
            );
            positions[vertexIndex * 3] = point.x;
            positions[vertexIndex * 3 + 1] = point.y;
            positions[vertexIndex * 3 + 2] = point.z;
        }
    }
    const intervalCount = (stations.length - 1) * (crossSectionOffsets.length - 1);
    const indices = new Uint32Array(intervalCount * 6);
    let cursor = 0;
    for (let stationIndex = 0; stationIndex < stations.length - 1; stationIndex += 1) {
        for (let offsetIndex = 0; offsetIndex < crossSectionOffsets.length - 1; offsetIndex += 1) {
            const left0 = stationIndex * crossSectionOffsets.length + offsetIndex;
            const right0 = left0 + 1;
            const left1 = (stationIndex + 1) * crossSectionOffsets.length + offsetIndex;
            const right1 = left1 + 1;
            // Upward-facing, with the same diagonal for foundation and strips.
            indices[cursor++] = left0;
            indices[cursor++] = right1;
            indices[cursor++] = left1;
            indices[cursor++] = left0;
            indices[cursor++] = right0;
            indices[cursor++] = right1;
        }
    }
    return { positions, indices };
}

function appendQuad(positions, a, b, c, d) {
    for (const point of [a, b, c, a, c, d]) {
        positions.push(point.x, point.y, point.z);
    }
}

export function buildProposalRoadCurbGeometryData(
    chunk,
    leftOffsetM,
    rightOffsetM,
    baseSceneYs,
    bottomOffsetY,
    topOffsetY,
    { capStart = chunk?.isLineStart === true, capEnd = chunk?.isLineEnd === true } = {},
) {
    const stations = Array.isArray(chunk?.stations) ? chunk.stations : [];
    if (stations.length < 2) return null;
    const left = Number(leftOffsetM);
    const right = Number(rightOffsetM);
    const bottom = Number(bottomOffsetY);
    const top = Number(topOffsetY);
    if (![left, right, bottom, top].every(Number.isFinite) || !(top > bottom)) return null;
    const baseYs = checkedBaseSceneYs(stations, baseSceneYs);
    const positions = [];
    const point = (stationIndex, offset, lift) => stationPoint(
        stations[stationIndex],
        offset,
        baseYs[stationIndex] + lift,
    );
    for (let index = 0; index < stations.length - 1; index += 1) {
        appendQuad(positions,
            point(index, left, bottom),
            point(index + 1, left, bottom),
            point(index + 1, left, top),
            point(index, left, top));
        appendQuad(positions,
            point(index + 1, right, bottom),
            point(index, right, bottom),
            point(index, right, top),
            point(index + 1, right, top));
    }
    if (capStart) {
        appendQuad(positions,
            point(0, right, bottom),
            point(0, left, bottom),
            point(0, left, top),
            point(0, right, top));
    }
    if (capEnd) {
        const last = stations.length - 1;
        appendQuad(positions,
            point(last, left, bottom),
            point(last, right, bottom),
            point(last, right, top),
            point(last, left, top));
    }
    return positions.length > 0 ? { positions: new Float32Array(positions) } : null;
}

export function proposalRoadStationChunksBounds(chunks, halfWidthM = 0) {
    const halfWidth = Math.max(0, Number(halfWidthM) || 0);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
        for (const station of chunk?.stations || []) {
            for (const offset of halfWidth > 0 ? [-halfWidth, halfWidth] : [0]) {
                const x = station.x + station.normalX * offset;
                const z = station.z + station.normalZ * offset;
                minX = Math.min(minX, x);
                minZ = Math.min(minZ, z);
                maxX = Math.max(maxX, x);
                maxZ = Math.max(maxZ, z);
            }
        }
    }
    return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

export function proposalRoadFormationChangeTouchesBounds(change, bounds) {
    if (!change || change.full || !bounds) return true;
    return (Array.isArray(change.bounds) ? change.bounds : []).some(changed => (
        changed
        && bounds.minX <= changed.maxX && bounds.maxX >= changed.minX
        && bounds.minZ <= changed.maxZ && bounds.maxZ >= changed.minZ
    ));
}

export function proposalRoadSurfaceOwnerNeedsRefresh(owner, change) {
    if (!owner?.surfaceBounds) return false;
    if (owner.renderedFormationRevision === change?.revision) return false;
    return proposalRoadFormationChangeTouchesBounds(change, owner.surfaceBounds);
}
