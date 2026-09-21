// Pure polygon helpers shared by the vector-authoritative sea mask and its
// quay-wall classifier, with no DGU raster or road-surface ownership inputs.

const RING_EDGE_BUCKET_M = 64;

function buildRingIndex(ring) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const buckets = new Map();
    for (let index = 0; index < ring.length - 1; index++) {
        const start = ring[index];
        const end = ring[index + 1];
        minX = Math.min(minX, start[0]);
        minZ = Math.min(minZ, start[1]);
        maxX = Math.max(maxX, start[0]);
        maxZ = Math.max(maxZ, start[1]);
        if (start[1] === end[1]) continue;
        const firstBucket = Math.floor(Math.min(start[1], end[1]) / RING_EDGE_BUCKET_M);
        const lastBucket = Math.floor(Math.max(start[1], end[1]) / RING_EDGE_BUCKET_M);
        for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
            let edges = buckets.get(bucket);
            if (!edges) {
                edges = [];
                buckets.set(bucket, edges);
            }
            edges.push(index);
        }
    }
    return { ring, minX, minZ, maxX, maxZ, buckets };
}

function pointInRing(x, z, index) {
    if (x < index.minX || x > index.maxX || z < index.minZ || z > index.maxZ) return false;
    const ring = index.ring;
    const edges = index.buckets.get(Math.floor(z / RING_EDGE_BUCKET_M)) || [];
    let inside = false;
    for (const i of edges) {
        const j = i + 1;
        const xi = ring[i][0];
        const zi = ring[i][1];
        const xj = ring[j][0];
        const zj = ring[j][1];
        if (((zi > z) !== (zj > z))
            && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-12) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function mappedWaterRings(poly) {
    if (!poly || !Array.isArray(poly.outer) || poly.outer.length < 4) return [];
    return [
        poly.outer,
        ...(Array.isArray(poly.holes) ? poly.holes : [])
            .filter((ring) => Array.isArray(ring) && ring.length >= 4),
    ];
}

export function selectMappedSeaFeatures(features) {
    const polygons = (features || []).filter((feature) => {
        const type = feature?.geometry?.type;
        return type === 'Polygon' || type === 'MultiPolygon';
    });
    for (const seaClass of ['ocean', 'strait', 'bay']) {
        const selected = polygons.filter((feature) => {
            const properties = feature.properties || {};
            return [properties.class, properties.subtype]
                .some((value) => String(value || '').toLowerCase() === seaClass);
        });
        if (selected.length > 0) return selected;
    }
    // No explicit marine feature means this is an inland water response, not
    // an incomplete sea response. Falling back to every polygon promoted
    // swimming pools, reflecting pools and ponds into the Croatia sea mask,
    // which then punched terrain holes throughout Zagreb.
    return [];
}

function samePoint(a, b) {
    return a && b && a[0] === b[0] && a[1] === b[1];
}

function pointSegmentDistanceSq(point, start, end) {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSq))
        : 0;
    const offsetX = point[0] - (start[0] + dx * t);
    const offsetZ = point[1] - (start[1] + dz * t);
    return offsetX * offsetX + offsetZ * offsetZ;
}

function simplifyOpenLine(points, toleranceSq) {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [startIndex, endIndex] = stack.pop();
        let furthestIndex = -1;
        let furthestDistanceSq = toleranceSq;
        for (let index = startIndex + 1; index < endIndex; index++) {
            const distanceSq = pointSegmentDistanceSq(points[index], points[startIndex], points[endIndex]);
            if (distanceSq > furthestDistanceSq) {
                furthestDistanceSq = distanceSq;
                furthestIndex = index;
            }
        }
        if (furthestIndex < 0) continue;
        keep[furthestIndex] = 1;
        stack.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
    }
    return points.filter((_, index) => keep[index]);
}

// Douglas-Peucker simplification adapted to a closed metric ring. The two
// open chains meet at a distant existing vertex, so closure cannot collapse
// the whole polygon into the ring's duplicate first/last coordinate.
export function simplifyClosedRing(ring, toleranceM) {
    if (!Array.isArray(ring) || ring.length < 4) return [];
    if (!ring.every((point) => Array.isArray(point)
        && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return [];
    const points = samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
    if (points.length < 3) return [];
    if (!(toleranceM > 0) || points.length === 3) return [...points, points[0]];

    let splitIndex = 1;
    let furthestDistanceSq = -1;
    for (let index = 1; index < points.length; index++) {
        const dx = points[index][0] - points[0][0];
        const dz = points[index][1] - points[0][1];
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > furthestDistanceSq) {
            furthestDistanceSq = distanceSq;
            splitIndex = index;
        }
    }

    const toleranceSq = toleranceM * toleranceM;
    const first = simplifyOpenLine(points.slice(0, splitIndex + 1), toleranceSq);
    const second = simplifyOpenLine(points.slice(splitIndex).concat([points[0]]), toleranceSq);
    const simplified = first.concat(second.slice(1, -1));
    if (simplified.length < 3) return [...points, points[0]];
    return [...simplified, simplified[0]];
}

export function createMappedCoastline(polys, { simplifyToleranceM = 0 } = {}) {
    const features = [];
    for (const poly of polys || []) {
        const sourceRings = mappedWaterRings(poly);
        if (sourceRings.length === 0) continue;
        const outer = simplifyClosedRing(sourceRings[0], simplifyToleranceM);
        if (outer.length < 4) continue;
        const holes = sourceRings.slice(1)
            .map((ring) => simplifyClosedRing(ring, simplifyToleranceM))
            .filter((ring) => ring.length >= 4);
        const simplifiedPoly = { outer, holes };
        const rings = [outer, ...holes];
        features.push({
            poly: simplifiedPoly,
            rings,
            ringIndexes: rings.map(buildRingIndex),
        });
    }
    const contains = (x, z) => {
        for (const feature of features) {
            const { ringIndexes } = feature;
            if (!pointInRing(x, z, ringIndexes[0])) continue;
            if (!ringIndexes.slice(1).some((hole) => pointInRing(x, z, hole))) return true;
        }
        return false;
    };
    return { features, contains };
}

function openMetricRing(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return [];
    return samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
}

function metricRingArea(ring) {
    let area = 0;
    for (let index = 0; index < ring.length; index++) {
        const point = ring[index];
        const next = ring[(index + 1) % ring.length];
        area += point[0] * next[1] - next[0] * point[1];
    }
    return area * 0.5;
}

function landNormalForSegment(coastline, start, end, ringArea, landIsRingInterior) {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return null;
    const windingSign = ringArea >= 0 ? 1 : -1;
    const interiorX = (-dz / length) * windingSign;
    const interiorZ = (dx / length) * windingSign;
    const landSign = landIsRingInterior ? 1 : -1;
    const normal = { x: interiorX * landSign, z: interiorZ * landSign };
    // MultiPolygon parts can share an ingest/clip edge. Ring winding alone
    // cannot distinguish that water|water edge from a real shore, so retain
    // only boundaries with land on the computed side and water opposite it.
    const midpointX = (start[0] + end[0]) * 0.5;
    const midpointZ = (start[1] + end[1]) * 0.5;
    const validationDistance = 0.25;
    const landSideIsWater = coastline.contains(
        midpointX + normal.x * validationDistance,
        midpointZ + normal.z * validationDistance,
    );
    const waterSideIsWater = coastline.contains(
        midpointX - normal.x * validationDistance,
        midpointZ - normal.z * validationDistance,
    );
    return !landSideIsWater && waterSideIsWater ? normal : null;
}

function landWidthForSegment(coastline, start, end, normal, widthM, minimumWidthM) {
    const midpointX = (start[0] + end[0]) * 0.5;
    const midpointZ = (start[1] + end[1]) * 0.5;
    const isWaterAt = (distance) => coastline.contains(
        midpointX + normal.x * distance,
        midpointZ + normal.z * distance,
    );
    if (!isWaterAt(widthM)) return widthM;
    const minimum = Math.min(widthM, Math.max(0.25, minimumWidthM));
    if (!isWaterAt(minimum)) return minimum;
    let safeWidth = 0.25;
    for (let distance = 0.5; distance < minimum; distance += 0.5) {
        if (isWaterAt(distance)) break;
        safeWidth = distance;
    }
    return safeWidth;
}

// Builds a continuous strip on the LAND side of every true water/land edge.
// The sea renderer uses it to hide raster-mask quantisation behind an exact
// vector seam. Segment-normal quads cannot swing across water at a concave
// corner; land-only join triangles close the remaining outer wedges.
function finishCoastPreparation(steps) {
    try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
    finally { steps.return(); }
}

function coastPreparationClock(now, isCurrent) {
    let deadline = now() + .5;
    return {
        check() { if (!isCurrent()) throw Object.assign(new Error('Coast preparation expired'), { code: 'ground-generation-stale' }); },
        *step() { this.check(); if (now() >= deadline) { yield { phase: 'coast-evidence' }; this.check(); deadline = now() + .5; } },
    };
}

export function buildMappedCoastLandCollar(coastline, options) {
    return finishCoastPreparation(buildMappedCoastLandCollarSteps(coastline, options));
}

export function* buildMappedCoastLandCollarSteps(coastline, {
    widthM = 4,
    minimumWidthM = 2,
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    const clock = coastPreparationClock(now, isCurrent);
    clock.check();
    if (!coastline || typeof coastline.contains !== 'function' || !(widthM > 0)) {
        return { quads: [], joins: [] };
    }
    const quads = [];
    const joins = [];
    for (const feature of coastline.features || []) {
        for (let ringIndex = 0; ringIndex < (feature.rings || []).length; ringIndex++) {
            const sourceRing = feature.rings[ringIndex];
            const ring = openMetricRing(sourceRing);
            if (ring.length < 3) continue;
            const ringArea = metricRingArea(ring);
            const landIsRingInterior = ringIndex > 0;
            const normals = [], widths = [];
            for (let index = 0; index < ring.length; index++) {
                yield* clock.step();
                normals.push(landNormalForSegment(coastline, ring[index], ring[(index + 1) % ring.length], ringArea, landIsRingInterior));
            }
            for (let index = 0; index < ring.length; index++) {
                yield* clock.step();
                widths.push(normals[index] ? landWidthForSegment(coastline, ring[index], ring[(index + 1) % ring.length],
                    normals[index], widthM, minimumWidthM) : 0);
            }
            for (let index = 0; index < ring.length; index++) {
                yield* clock.step();
                const normal = normals[index];
                if (!normal) continue;
                const nextIndex = (index + 1) % ring.length;
                const shoreA = ring[index];
                const shoreB = ring[nextIndex];
                const width = widths[index];
                quads.push({
                    shoreA,
                    shoreB,
                    landA: [shoreA[0] + normal.x * width, shoreA[1] + normal.z * width],
                    landB: [shoreB[0] + normal.x * width, shoreB[1] + normal.z * width],
                });
            }
            for (let index = 0; index < ring.length; index++) {
                yield* clock.step();
                const previous = normals[(index - 1 + ring.length) % ring.length];
                const next = normals[index];
                if (!previous || !next) continue;
                const shore = ring[index];
                const previousWidth = widths[(index - 1 + ring.length) % ring.length];
                const nextWidth = widths[index];
                const landPrevious = [
                    shore[0] + previous.x * previousWidth,
                    shore[1] + previous.z * previousWidth,
                ];
                const landNext = [
                    shore[0] + next.x * nextWidth,
                    shore[1] + next.z * nextWidth,
                ];
                if (Math.hypot(
                    landNext[0] - landPrevious[0],
                    landNext[1] - landPrevious[1],
                ) < 0.01) continue;
                const centroidX = (shore[0] + landPrevious[0] + landNext[0]) / 3;
                const centroidZ = (shore[1] + landPrevious[1] + landNext[1]) / 3;
                if (coastline.contains(centroidX, centroidZ)) continue;
                joins.push({ shore, landPrevious, landNext });
            }
        }
    }
    clock.check(); return { quads, joins };
}

function coastRayKey(shore, land) {
    return `${shore[0]}:${shore[1]}|${land[0]}:${land[1]}`;
}

// DGU legitimately ends in NoData before the mapped shoreline in places. The
// fixed seam collar must not turn that permanent source gap into a permanent
// hole, nor may it jump across a narrow inlet to terrain on the other side.
// Extend each existing LAND-side collar ray only while it remains classified
// as land, then stop at the nearest evidenced terrain sample. Adjacent quads
// and corner joins share cached, bit-identical resolved vertices.
export function resolveMappedCoastTerrainInfill(collar, options) {
    return finishCoastPreparation(resolveMappedCoastTerrainInfillSteps(collar, options));
}

export function* resolveMappedCoastTerrainInfillSteps(collar, {
    coastline,
    evidenceSceneYAtLocal,
    shoreSceneY,
    surfaceLiftM = 0,
    maxReachM = 128,
    probeStepM = 4,
    waterCheckStepM = 1,
    refineIterations = 4,
    maxInferenceSpanM = 64,
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    const clock = coastPreparationClock(now, isCurrent);
    clock.check();
    const empty = {
        quads: [],
        joins: [],
        diagnostics: {
            resolvedRayCount: 0,
            extendedRayCount: 0,
            inferredRayCount: 0,
            unresolvedRayCount: 0,
            omittedQuadCount: Array.isArray(collar?.quads) ? collar.quads.length : 0,
            omittedJoinCount: Array.isArray(collar?.joins) ? collar.joins.length : 0,
            maximumResolvedReachM: 0,
        },
    };
    if (!collar || !coastline || typeof coastline.contains !== 'function'
        || typeof evidenceSceneYAtLocal !== 'function'
        || !Number.isFinite(shoreSceneY)
        || !(maxReachM > 0) || !(probeStepM > 0) || !(waterCheckStepM > 0)) {
        return empty;
    }

    const cache = new Map();
    let resolvedRayCount = 0;
    let extendedRayCount = 0;
    let inferredRayCount = 0;
    let unresolvedRayCount = 0;
    let maximumResolvedReachM = 0;
    const evidenceAt = (point) => {
        const value = evidenceSceneYAtLocal(point[0], point[1]);
        return typeof value === 'number' && Number.isFinite(value)
            ? value + surfaceLiftM
            : null;
    };
    const pointAt = (shore, unitX, unitZ, distance) => [
        shore[0] + unitX * distance,
        shore[1] + unitZ * distance,
    ];
    const rayIntervalStaysOnLand = function* (shore, unitX, unitZ, fromM, toM) {
        for (let distance = fromM + waterCheckStepM; distance < toM; distance += waterCheckStepM) {
            yield* clock.step();
            const point = pointAt(shore, unitX, unitZ, distance);
            if (coastline.contains(point[0], point[1])) return false;
        }
        const end = pointAt(shore, unitX, unitZ, toM);
        return !coastline.contains(end[0], end[1]);
    };
    const resolveRay = function* (shore, land) {
        yield* clock.step();
        const key = coastRayKey(shore, land);
        if (cache.has(key)) return cache.get(key);
        const dx = land[0] - shore[0];
        const dz = land[1] - shore[1];
        const baseReachM = Math.hypot(dx, dz);
        if (!(baseReachM > 0.01) || baseReachM > maxReachM
            || coastline.contains(land[0], land[1])) {
            unresolvedRayCount += 1;
            cache.set(key, null);
            return null;
        }
        const unitX = dx / baseReachM;
        const unitZ = dz / baseReachM;
        const baseY = evidenceAt(land);
        if (baseY !== null) {
            const resolved = {
                point: land.slice(),
                sceneY: baseY,
                shoreSceneY,
                reachM: baseReachM,
                extended: false,
            };
            resolvedRayCount += 1;
            maximumResolvedReachM = Math.max(maximumResolvedReachM, baseReachM);
            cache.set(key, resolved);
            return resolved;
        }

        let lowerM = baseReachM;
        while (lowerM < maxReachM - 1e-6) {
            yield* clock.step();
            const upperM = Math.min(maxReachM, lowerM + probeStepM);
            if (!(yield* rayIntervalStaysOnLand(shore, unitX, unitZ, lowerM, upperM))) break;
            const upperPoint = pointAt(shore, unitX, unitZ, upperM);
            let upperY = evidenceAt(upperPoint);
            if (upperY !== null) {
                let validM = upperM;
                let validPoint = upperPoint;
                let missingM = lowerM;
                for (let iteration = 0; iteration < refineIterations; iteration++) {
                    yield* clock.step();
                    const middleM = (missingM + validM) * 0.5;
                    const middlePoint = pointAt(shore, unitX, unitZ, middleM);
                    if (coastline.contains(middlePoint[0], middlePoint[1])) break;
                    const middleY = evidenceAt(middlePoint);
                    if (middleY === null) {
                        missingM = middleM;
                    } else {
                        validM = middleM;
                        validPoint = middlePoint;
                        upperY = middleY;
                    }
                }
                const resolved = {
                    point: validPoint,
                    sceneY: upperY,
                    shoreSceneY,
                    reachM: validM,
                    extended: true,
                };
                resolvedRayCount += 1;
                extendedRayCount += 1;
                maximumResolvedReachM = Math.max(maximumResolvedReachM, validM);
                cache.set(key, resolved);
                return resolved;
            }
            lowerM = upperM;
        }
        unresolvedRayCount += 1;
        cache.set(key, null);
        return null;
    };

    // A short run of missing DGU rays inside an otherwise evidenced shoreline
    // is a source-grid gap, not a reason to cut a literal opening in the coast.
    // Resolve every ray first, then interpolate only between neighbouring
    // resolved rays on the same contiguous OSM boundary chain. The inferred
    // ray keeps its own landward direction and is accepted only if that whole
    // reach remains on land, so a narrow inlet can never be bridged.
    const chains = [];
    let chain = null;
    const rayNode = (shore, land) => ({ shore, land, key: coastRayKey(shore, land) });
    const appendNode = (nodes, node) => {
        if (nodes[nodes.length - 1]?.key !== node.key) nodes.push(node);
    };
    for (const quad of collar.quads || []) {
        yield* clock.step();
        const a = rayNode(quad.shoreA, quad.landA);
        const b = rayNode(quad.shoreB, quad.landB);
        const continues = chain && samePoint(chain[chain.length - 1].shore, a.shore);
        if (!continues) {
            chain = [];
            chains.push(chain);
        }
        appendNode(chain, a);
        appendNode(chain, b);
    }
    for (const nodes of chains) {
        if (nodes.length < 2) continue;
        const distanceAt = [0];
        for (let index = 1; index < nodes.length; index++) {
            yield* clock.step();
            distanceAt.push(distanceAt[index - 1] + Math.hypot(
                nodes[index].shore[0] - nodes[index - 1].shore[0],
                nodes[index].shore[1] - nodes[index - 1].shore[1],
            ));
        }
        for (const node of nodes) yield* resolveRay(node.shore, node.land);
        let runStart = 0;
        while (runStart < nodes.length) {
            yield* clock.step();
            if (cache.get(nodes[runStart].key) !== null) {
                runStart += 1;
                continue;
            }
            let runEnd = runStart;
            while (runEnd + 1 < nodes.length && cache.get(nodes[runEnd + 1].key) === null) {
                yield* clock.step(); runEnd += 1;
            }
            const leftIndex = runStart - 1;
            const rightIndex = runEnd + 1;
            const left = leftIndex >= 0 ? cache.get(nodes[leftIndex].key) : null;
            const right = rightIndex < nodes.length ? cache.get(nodes[rightIndex].key) : null;
            const supportedSpanM = left && right
                ? distanceAt[rightIndex] - distanceAt[leftIndex]
                : left
                    ? distanceAt[runEnd] - distanceAt[leftIndex]
                    : right
                        ? distanceAt[rightIndex] - distanceAt[runStart]
                        : Infinity;
            const allowedSpanM = left && right
                ? maxInferenceSpanM
                : maxInferenceSpanM * 0.5;
            if ((left || right) && supportedSpanM <= allowedSpanM) {
                for (let index = runStart; index <= runEnd; index++) {
                    yield* clock.step();
                    const node = nodes[index];
                    if (cache.get(node.key) !== null) continue;
                    const dx = node.land[0] - node.shore[0];
                    const dz = node.land[1] - node.shore[1];
                    const baseReachM = Math.hypot(dx, dz);
                    if (!(baseReachM > 0.01)) continue;
                    const t = left && right && distanceAt[rightIndex] > distanceAt[leftIndex]
                        ? (distanceAt[index] - distanceAt[leftIndex])
                            / (distanceAt[rightIndex] - distanceAt[leftIndex])
                        : left ? 0 : 1;
                    const inferredReachM = Math.max(baseReachM, left && right
                        ? left.reachM + (right.reachM - left.reachM) * t
                        : (left || right).reachM);
                    const unitX = dx / baseReachM;
                    const unitZ = dz / baseReachM;
                    if (inferredReachM > maxReachM
                        || !(yield* rayIntervalStaysOnLand(
                            node.shore,
                            unitX,
                            unitZ,
                            0,
                            inferredReachM,
                        ))) continue;
                    const inferred = {
                        point: pointAt(node.shore, unitX, unitZ, inferredReachM),
                        sceneY: left && right
                            ? left.sceneY + (right.sceneY - left.sceneY) * t
                            : (left || right).sceneY,
                        shoreSceneY,
                        reachM: inferredReachM,
                        extended: inferredReachM > baseReachM + 1e-6,
                        inferred: true,
                    };
                    cache.set(node.key, inferred);
                    unresolvedRayCount -= 1;
                    resolvedRayCount += 1;
                    inferredRayCount += 1;
                    maximumResolvedReachM = Math.max(
                        maximumResolvedReachM,
                        inferredReachM,
                    );
                }
            }
            runStart = runEnd + 1;
        }
    }

    const quads = [];
    let omittedQuadCount = 0;
    for (const quad of collar.quads || []) {
        const a = yield* resolveRay(quad.shoreA, quad.landA);
        const b = yield* resolveRay(quad.shoreB, quad.landB);
        if (!a || !b) {
            omittedQuadCount += 1;
            continue;
        }
        quads.push({
            shoreA: quad.shoreA,
            shoreB: quad.shoreB,
            landA: a.point,
            landB: b.point,
            shoreAY: a.shoreSceneY,
            shoreBY: b.shoreSceneY,
            landAY: a.sceneY,
            landBY: b.sceneY,
            extendedA: a.extended,
            extendedB: b.extended,
        });
    }
    const joins = [];
    let omittedJoinCount = 0;
    for (const join of collar.joins || []) {
        const previous = yield* resolveRay(join.shore, join.landPrevious);
        const next = yield* resolveRay(join.shore, join.landNext);
        if (!previous || !next) {
            omittedJoinCount += 1;
            continue;
        }
        joins.push({
            shore: join.shore,
            landPrevious: previous.point,
            landNext: next.point,
            shoreY: shoreSceneY,
            landPreviousY: previous.sceneY,
            landNextY: next.sceneY,
            extendedPrevious: previous.extended,
            extendedNext: next.extended,
        });
    }
    clock.check(); return {
        quads,
        joins,
        diagnostics: {
            resolvedRayCount,
            extendedRayCount,
            inferredRayCount,
            unresolvedRayCount,
            omittedQuadCount,
            omittedJoinCount,
            maximumResolvedReachM,
        },
    };
}

function coastCutPoint(shore, land, innerOverlapM) {
    const dx = land[0] - shore[0];
    const dz = land[1] - shore[1];
    const reachM = Math.hypot(dx, dz);
    if (!(reachM > 0.01)) return null;
    const cutReachM = Math.max(0, reachM - Math.max(0, innerOverlapM));
    if (!(cutReachM > 0.01)) return null;
    const scale = cutReachM / reachM;
    return [shore[0] + dx * scale, shore[1] + dz * scale];
}

// The OSM shoreline transition replaces, rather than merely overpaints, the
// DGU surface beneath it. Build the exact land-side region which the terrain
// mask removes, stopping slightly short of the infill's inner edge so the two
// surfaces retain a small opaque overlap despite raster-mask quantisation.
// Water visibility remains a separate OSM-polygon channel; this cutout only
// decides where the original terrain yields to the generated coast surface.
// Clip the shoreline and interpolate its paired land edge together. Selecting
// by a segment's midpoint loses long coasts that cross the loaded window.
export function clipMappedCoastQuadToWindow(quad, centerX, centerZ, halfSizeM) {
    if (![centerX, centerZ, halfSizeM].every(Number.isFinite) || halfSizeM <= 0) throw new TypeError('Coast clipping requires a finite window');
    let start = 0, end = 1;
    for (const [axis, center] of [[0, centerX], [1, centerZ]]) {
        const a = quad.shoreA[axis], delta = quad.shoreB[axis] - a;
        if (delta === 0) { if (a < center - halfSizeM || a > center + halfSizeM) return null; continue; }
        const t1 = (center - halfSizeM - a) / delta, t2 = (center + halfSizeM - a) / delta;
        start = Math.max(start, Math.min(t1, t2)); end = Math.min(end, Math.max(t1, t2));
        if (start >= end) return null;
    }
    if (start === 0 && end === 1) return quad;
    const at = (a, b, t) => t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return { ...quad, shoreA: at(quad.shoreA, quad.shoreB, start), shoreB: at(quad.shoreA, quad.shoreB, end),
        landA: at(quad.landA, quad.landB, start), landB: at(quad.landA, quad.landB, end) };
}

export function buildMappedCoastTerrainCutout(infill, {
    innerOverlapM = 0.75,
} = {}) {
    const quads = [];
    for (const quad of infill?.quads || []) {
        const landA = coastCutPoint(quad.shoreA, quad.landA, innerOverlapM);
        const landB = coastCutPoint(quad.shoreB, quad.landB, innerOverlapM);
        if (!landA || !landB) continue;
        quads.push({
            shoreA: quad.shoreA,
            shoreB: quad.shoreB,
            landA,
            landB,
        });
    }
    const joins = [];
    for (const join of infill?.joins || []) {
        const landPrevious = coastCutPoint(
            join.shore,
            join.landPrevious,
            innerOverlapM,
        );
        const landNext = coastCutPoint(join.shore, join.landNext, innerOverlapM);
        if (!landPrevious || !landNext) continue;
        joins.push({
            shore: join.shore,
            landPrevious,
            landNext,
        });
    }
    return { quads, joins };
}

// Index the exact triangles uploaded for the mapped-coast terrain replacement.
// Civil solvers use this sampler so their cut/fill toes meet the rendered
// transition instead of the raw DGU triangle that the coastline mask removed.
export function createMappedCoastTerrainSurfaceSampler(positions, {
    bucketSizeM = 32,
} = {}) {
    const values = positions instanceof Float32Array || positions instanceof Float64Array
        ? positions
        : Array.isArray(positions)
            ? positions
            : null;
    if (!values || values.length < 9) return null;
    const bucketSize = Math.max(1, Number(bucketSizeM) || 32);
    const triangles = [];
    const buckets = new Map();
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const bucketKey = (x, z) => `${x}:${z}`;
    for (let offset = 0; offset + 8 < values.length; offset += 9) {
        const ax = Number(values[offset]);
        const ay = Number(values[offset + 1]);
        const az = Number(values[offset + 2]);
        const bx = Number(values[offset + 3]);
        const by = Number(values[offset + 4]);
        const bz = Number(values[offset + 5]);
        const cx = Number(values[offset + 6]);
        const cy = Number(values[offset + 7]);
        const cz = Number(values[offset + 8]);
        if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
        const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denominator) <= 1e-10) continue;
        const triangle = {
            ax, ay, az, bx, by, bz, cx, cy, cz, denominator,
            minX: Math.min(ax, bx, cx),
            minZ: Math.min(az, bz, cz),
            maxX: Math.max(ax, bx, cx),
            maxZ: Math.max(az, bz, cz),
        };
        const triangleIndex = triangles.push(triangle) - 1;
        minX = Math.min(minX, triangle.minX);
        minZ = Math.min(minZ, triangle.minZ);
        maxX = Math.max(maxX, triangle.maxX);
        maxZ = Math.max(maxZ, triangle.maxZ);
        const firstBucketX = Math.floor(triangle.minX / bucketSize);
        const lastBucketX = Math.floor(triangle.maxX / bucketSize);
        const firstBucketZ = Math.floor(triangle.minZ / bucketSize);
        const lastBucketZ = Math.floor(triangle.maxZ / bucketSize);
        for (let bucketX = firstBucketX; bucketX <= lastBucketX; bucketX++) {
            for (let bucketZ = firstBucketZ; bucketZ <= lastBucketZ; bucketZ++) {
                const key = bucketKey(bucketX, bucketZ);
                let entries = buckets.get(key);
                if (!entries) {
                    entries = [];
                    buckets.set(key, entries);
                }
                entries.push(triangleIndex);
            }
        }
    }
    if (triangles.length === 0) return null;
    const sample = (x, z) => {
        const localX = Number(x);
        const localZ = Number(z);
        if (!Number.isFinite(localX) || !Number.isFinite(localZ)
            || localX < minX - 1e-6 || localX > maxX + 1e-6
            || localZ < minZ - 1e-6 || localZ > maxZ + 1e-6) return null;
        const candidates = buckets.get(bucketKey(
            Math.floor(localX / bucketSize),
            Math.floor(localZ / bucketSize),
        )) || [];
        let sceneY = null;
        for (const triangleIndex of candidates) {
            const triangle = triangles[triangleIndex];
            if (localX < triangle.minX - 1e-6 || localX > triangle.maxX + 1e-6
                || localZ < triangle.minZ - 1e-6 || localZ > triangle.maxZ + 1e-6) continue;
            const wa = ((triangle.bz - triangle.cz) * (localX - triangle.cx)
                + (triangle.cx - triangle.bx) * (localZ - triangle.cz))
                / triangle.denominator;
            const wb = ((triangle.cz - triangle.az) * (localX - triangle.cx)
                + (triangle.ax - triangle.cx) * (localZ - triangle.cz))
                / triangle.denominator;
            const wc = 1 - wa - wb;
            if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
            const candidateY = wa * triangle.ay + wb * triangle.by + wc * triangle.cy;
            if (Number.isFinite(candidateY)) {
                sceneY = sceneY == null ? candidateY : Math.max(sceneY, candidateY);
            }
        }
        return sceneY;
    };
    sample.bounds = { minX, minZ, maxX, maxZ };
    sample.triangleCount = triangles.length;
    return sample;
}
