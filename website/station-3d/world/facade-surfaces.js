// Builds logical facade surfaces from wall triangles and answers exact
// rectangle-containment queries against their projected triangle union.

const GEOMETRY_EPSILON_M = 1e-6;
const COVERAGE_EPSILON_M = 0.002;
// ~3.6°: GDI walls that LOOK flat are often warped ruled surfaces whose
// triangle normals differ by 1–2° (twisted quads). The running plane refit
// plus the local plane tolerance below are the real guard against merging
// distinct walls — a genuinely curved facade breaks the 8 cm fit within a
// 20 m chord unless its radius exceeds ~600 m, and real corners are far
// beyond any normal gate.
const DEFAULT_NORMAL_DOT = 0.998;
const DEFAULT_PLANE_TOLERANCE_M = 0.08;
const DEFAULT_CONNECT_TOLERANCE_M = 0.04;
// Coverage preparation is pure work over an immutable projected wall. Yield
// often enough that the building queue can enforce its frame deadline, then
// retain the completed index for every opening and late passage repaint.
const COVERAGE_INDEX_WORK_PER_STAGE = 512;
const coverageIndexCache = new WeakMap();

function canonicalWallPlane(triangle) {
    if (!Array.isArray(triangle) || triangle.length !== 3) return null;
    const [a, b, c] = triangle;
    if (![a, b, c].every((point) => Array.isArray(point) && point.length >= 3 &&
        point.slice(0, 3).every(Number.isFinite))) return null;

    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const fullLength = Math.hypot(nx, ny, nz);
    const horizontalLength = Math.hypot(nx, nz);
    if (fullLength < GEOMETRY_EPSILON_M || horizontalLength < GEOMETRY_EPSILON_M ||
        Math.abs(ny) / fullLength > 0.5) return null;
    nx /= horizontalLength;
    nz /= horizontalLength;
    // Record which canonical half-plane the ring's own normal fell in before the
    // normal was canonicalised, so party-wall classification can distinguish
    // adjacent solids from overlapping duplicate shells. Only the RELATIVE sign
    // carries meaning (two solids on opposite sides of one line share a wall):
    // the absolute side depends on GDI's ring winding and is not a reliable
    // inside/outside test. Callers that need to know which way a wall FACES
    // resolve it against the building's centroid — see world/street-facing.js
    // and the contact-AO skirts in world/buildings.js.
    let interiorSide = -1;
    let d = (triangle.reduce((sum, point) => sum + nx * point[0] + nz * point[2], 0)) / 3;
    if (nx < -GEOMETRY_EPSILON_M || (Math.abs(nx) <= GEOMETRY_EPSILON_M && nz < 0)) {
        nx = -nx;
        nz = -nz;
        d = -d;
        interiorSide = 1;
    }
    const spread = Math.max(...triangle.map((point) =>
        Math.abs(nx * point[0] + nz * point[2] - d)));
    return { nx, nz, d, spread, interiorSide };
}

function projectTriangle(triangle, tx, tz) {
    return triangle.map((point) => ({
        u: point[0] * tx + point[2] * tz,
        v: point[1],
    }));
}

function triangleBounds(triangle) {
    return {
        minU: Math.min(triangle[0].u, triangle[1].u, triangle[2].u),
        maxU: Math.max(triangle[0].u, triangle[1].u, triangle[2].u),
        minV: Math.min(triangle[0].v, triangle[1].v, triangle[2].v),
        maxV: Math.max(triangle[0].v, triangle[1].v, triangle[2].v),
    };
}

function orientation(a, b, c) {
    return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function pointInTriangle(point, triangle, epsilon = GEOMETRY_EPSILON_M) {
    const o0 = orientation(triangle[0], triangle[1], point);
    const o1 = orientation(triangle[1], triangle[2], point);
    const o2 = orientation(triangle[2], triangle[0], point);
    const hasNegative = o0 < -epsilon || o1 < -epsilon || o2 < -epsilon;
    const hasPositive = o0 > epsilon || o1 > epsilon || o2 > epsilon;
    return !(hasNegative && hasPositive);
}

function segmentsIntersect(a, b, c, d, epsilon = GEOMETRY_EPSILON_M) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return (o1 <= epsilon && o2 >= -epsilon || o2 <= epsilon && o1 >= -epsilon) &&
        (o3 <= epsilon && o4 >= -epsilon || o4 <= epsilon && o3 >= -epsilon);
}

function pointSegmentDistanceSq(point, a, b) {
    const du = b.u - a.u, dv = b.v - a.v;
    const lengthSq = du * du + dv * dv;
    let t = lengthSq > GEOMETRY_EPSILON_M
        ? ((point.u - a.u) * du + (point.v - a.v) * dv) / lengthSq
        : 0;
    t = Math.max(0, Math.min(1, t));
    const u = a.u + du * t, v = a.v + dv * t;
    return (point.u - u) ** 2 + (point.v - v) ** 2;
}

function trianglesTouch(a, b, toleranceM) {
    const ab = a.bounds || triangleBounds(a);
    const bb = b.bounds || triangleBounds(b);
    if (ab.maxU < bb.minU - toleranceM || bb.maxU < ab.minU - toleranceM ||
        ab.maxV < bb.minV - toleranceM || bb.maxV < ab.minV - toleranceM) return false;
    if (a.some((point) => pointInTriangle(point, b, toleranceM)) ||
        b.some((point) => pointInTriangle(point, a, toleranceM))) return true;
    const toleranceSq = toleranceM * toleranceM;
    for (let ai = 0; ai < 3; ai++) {
        const aa = a[ai], abPoint = a[(ai + 1) % 3];
        for (let bi = 0; bi < 3; bi++) {
            const ba = b[bi], bbPoint = b[(bi + 1) % 3];
            if (segmentsIntersect(aa, abPoint, ba, bbPoint, toleranceM)) return true;
            if (pointSegmentDistanceSq(aa, ba, bbPoint) <= toleranceSq ||
                pointSegmentDistanceSq(abPoint, ba, bbPoint) <= toleranceSq ||
                pointSegmentDistanceSq(ba, aa, abPoint) <= toleranceSq ||
                pointSegmentDistanceSq(bbPoint, aa, abPoint) <= toleranceSq) return true;
        }
    }
    return false;
}

function* splitConnectedTrianglesCooperative(projected, toleranceM) {
    const parent = projected.map((_, index) => index);
    const find = (index) => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const join = (a, b) => {
        const ar = find(a), br = find(b);
        if (ar !== br) parent[br] = ar;
    };
    for (const triangle of projected) triangle.bounds = triangleBounds(triangle);
    let comparisons = 0;
    for (let i = 0; i < projected.length; i++) {
        for (let j = i + 1; j < projected.length; j++) {
            if (trianglesTouch(projected[i], projected[j], toleranceM)) join(i, j);
            comparisons += 1;
            if (comparisons % 128 === 0) {
                yield { phase: 'facade-connectivity' };
            }
        }
    }
    const components = new Map();
    for (let i = 0; i < projected.length; i++) {
        const root = find(i);
        const entries = components.get(root) || [];
        entries.push(i);
        components.set(root, entries);
    }
    return [...components.values()];
}

function drainIterator(iterator) {
    let next;
    do {
        next = iterator.next();
    } while (!next.done);
    return next.value;
}

// Triangles belong to one logical wall only when they are tightly coplanar and
// connected in that plane. A setback therefore never joins its front wall,
// even when their 2D projections overlap perfectly.
export function* buildLogicalFacadeSurfacesCooperative(wallTriangles, options = {}) {
    const normalDot = options.normalDot ?? DEFAULT_NORMAL_DOT;
    const planeToleranceM = options.planeToleranceM ?? DEFAULT_PLANE_TOLERANCE_M;
    const connectToleranceM = options.connectToleranceM ?? DEFAULT_CONNECT_TOLERANCE_M;
    const described = [];
    let describedCount = 0;
    for (const worldTriangle of wallTriangles || []) {
        const plane = canonicalWallPlane(worldTriangle);
        if (plane && plane.spread <= planeToleranceM) described.push({ worldTriangle, plane });
        describedCount += 1;
        if (describedCount % 64 === 0) yield { phase: 'facade-describe' };
    }

    // Groups are tested against a RUNNING area-weighted plane fit, not the
    // seed triangle's plane. A seed tilted a fraction of a degree (well
    // inside the normal tolerance) drifts past the plane tolerance over a
    // 20–40 m wall — plane offsets act on a long lever — and the wall
    // shatters into strips too narrow to earn a facade grid. Refitting as
    // the group grows keeps one flat-ish wall one surface; the per-triangle
    // normalDot bound still stops genuinely curved walls from chaining far.
    const triangleAreaWeight = (triangle) => {
        const [a, b, c] = triangle;
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
        return Math.hypot(
            aby * acz - abz * acy,
            abz * acx - abx * acz,
            abx * acy - aby * acx,
        ) * 0.5 + GEOMETRY_EPSILON_M;
    };
    const addToFit = (group, entry) => {
        const weight = triangleAreaWeight(entry.worldTriangle);
        group.fitNx += entry.plane.nx * weight;
        group.fitNz += entry.plane.nz * weight;
        let px = 0, pz = 0;
        for (const point of entry.worldTriangle) { px += point[0]; pz += point[2]; }
        group.fitPx += (px / 3) * weight;
        group.fitPz += (pz / 3) * weight;
        group.fitWeight += weight;
        const len = Math.hypot(group.fitNx, group.fitNz) || 1e-9;
        group.nx = group.fitNx / len;
        group.nz = group.fitNz / len;
        // Plane through the weighted centroid: measured locally, so no
        // anchor-distance lever amplifies normal noise into offset error.
        group.d = (group.nx * group.fitPx + group.nz * group.fitPz) / group.fitWeight;
    };
    const planeGroups = [];
    let groupedCount = 0;
    for (const entry of described) {
        let group = null;
        for (const candidate of planeGroups) {
            if (candidate.interiorSide !== entry.plane.interiorSide) continue;
            if (candidate.nx * entry.plane.nx + candidate.nz * entry.plane.nz < normalDot) continue;
            const fitsPlane = entry.worldTriangle.every((point) =>
                Math.abs(candidate.nx * point[0] + candidate.nz * point[2] - candidate.d) <= planeToleranceM);
            if (fitsPlane) { group = candidate; break; }
        }
        if (!group) {
            group = {
                ...entry.plane,
                entries: [],
                fitNx: 0, fitNz: 0, fitPx: 0, fitPz: 0, fitWeight: 0,
            };
            planeGroups.push(group);
        }
        group.entries.push(entry);
        addToFit(group, entry);
        groupedCount += 1;
        if (groupedCount % 32 === 0) yield { phase: 'facade-plane-groups' };
    }

    const surfaces = [];
    for (const group of planeGroups) {
        const tx = group.nz, tz = -group.nx;
        const projected = group.entries.map((entry) => projectTriangle(entry.worldTriangle, tx, tz));
        const components = yield* splitConnectedTrianglesCooperative(
            projected,
            connectToleranceM,
        );
        for (const component of components) {
            const triangles = component.map((index) => projected[index]);
            const world = component.map((index) => group.entries[index].worldTriangle);
            const bounds = triangles.reduce((result, triangle) => {
                const b = triangle.bounds || triangleBounds(triangle);
                result.minU = Math.min(result.minU, b.minU);
                result.maxU = Math.max(result.maxU, b.maxU);
                result.minV = Math.min(result.minV, b.minV);
                result.maxV = Math.max(result.maxV, b.maxV);
                return result;
            }, { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity });
            surfaces.push({
                nx: group.nx,
                nz: group.nz,
                d: group.d,
                interiorSide: group.interiorSide,
                tx,
                tz,
                triangles,
                worldTriangles: world,
                ...bounds,
            });
        }
        yield { phase: 'facade-surface-groups' };
    }
    return surfaces;
}

export function buildLogicalFacadeSurfaces(wallTriangles, options = {}) {
    return drainIterator(buildLogicalFacadeSurfacesCooperative(wallTriangles, options));
}

// Rebuild the final metric surface descriptors from precomputed plane-fit and
// merged-surface memberships. The expensive connectivity and duplicate-surface
// work has already happened offline; refitting planes and projecting triangles
// here is linear. Refitting is intentional: the payload is anchor-independent,
// while d/minU/maxU depend on the current scene origin. A malformed or stale
// payload returns null so callers can run the full topology builder instead of
// trusting partial geometry.
export function restoreLogicalFacadeSurfaces(wallTriangles, topology) {
    if (!Array.isArray(wallTriangles) || !topology
        || !Array.isArray(topology.fits) || !Array.isArray(topology.surfaces)) return null;
    const fits = [];
    const fittedTriangles = new Set();
    for (const cachedFit of topology.fits) {
        const planeIndexes = cachedFit && cachedFit.triangles;
        if (!Array.isArray(planeIndexes) || planeIndexes.length === 0) return null;
        let fitNx = 0;
        let fitNz = 0;
        let fitPx = 0;
        let fitPz = 0;
        let fitWeight = 0;
        let interiorSide = null;
        for (const rawIndex of planeIndexes) {
            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 0 || index >= wallTriangles.length
                || fittedTriangles.has(index)) return null;
            fittedTriangles.add(index);
            const worldTriangle = wallTriangles[index];
            const plane = canonicalWallPlane(worldTriangle);
            if (!plane) return null;
            if (interiorSide == null) interiorSide = plane.interiorSide;
            // mergeDuplicateWallSurfaces deliberately absorbs an overlapping
            // patch into its first host. Source meshes sometimes wind those
            // duplicate patches oppositely, so the host's side is authoritative
            // just as it is in the uncached path.
            const [a, b, c] = worldTriangle;
            const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
            const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
            const weight = Math.hypot(
                aby * acz - abz * acy,
                abz * acx - abx * acz,
                abx * acy - aby * acx,
            ) * 0.5 + GEOMETRY_EPSILON_M;
            fitNx += plane.nx * weight;
            fitNz += plane.nz * weight;
            fitPx += ((a[0] + b[0] + c[0]) / 3) * weight;
            fitPz += ((a[2] + b[2] + c[2]) / 3) * weight;
            fitWeight += weight;
        }
        const normalLength = Math.hypot(fitNx, fitNz);
        if (!(normalLength > GEOMETRY_EPSILON_M) || !(fitWeight > 0)) return null;
        const nx = fitNx / normalLength;
        const nz = fitNz / normalLength;
        const d = (nx * fitPx + nz * fitPz) / fitWeight;
        const tx = nz;
        const tz = -nx;
        fits.push({ nx, nz, d, interiorSide, tx, tz });
    }
    if (fittedTriangles.size !== wallTriangles.length) return null;

    const surfaces = [];
    const claimed = new Set();
    for (const cachedSurface of topology.surfaces) {
        const fitIndex = Number(cachedSurface && cachedSurface.fit);
        const indexes = cachedSurface && cachedSurface.triangles;
        if (!Number.isInteger(fitIndex) || fitIndex < 0 || fitIndex >= fits.length
            || !Array.isArray(indexes) || indexes.length === 0) return null;
        const entries = [];
        for (const rawIndex of indexes) {
            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 0 || index >= wallTriangles.length
                || claimed.has(index)) return null;
            claimed.add(index);
            entries.push(wallTriangles[index]);
        }
        const fit = fits[fitIndex];
        const triangles = entries.map((triangle) => projectTriangle(triangle, fit.tx, fit.tz));
        const bounds = triangles.reduce((result, triangle) => {
            const b = triangleBounds(triangle);
            result.minU = Math.min(result.minU, b.minU);
            result.maxU = Math.max(result.maxU, b.maxU);
            result.minV = Math.min(result.minV, b.minV);
            result.maxV = Math.max(result.maxV, b.maxV);
            return result;
        }, { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity });
        surfaces.push({
            ...fit,
            triangles,
            worldTriangles: entries,
            ...bounds,
        });
    }
    if (claimed.size !== wallTriangles.length) return null;
    return surfaces;
}

function edgeIntersection(a, b, c, d) {
    const rU = b.u - a.u, rV = b.v - a.v;
    const sU = d.u - c.u, sV = d.v - c.v;
    const denominator = rU * sV - rV * sU;
    if (Math.abs(denominator) < GEOMETRY_EPSILON_M) return null;
    const caU = c.u - a.u, caV = c.v - a.v;
    const t = (caU * sV - caV * sU) / denominator;
    const q = (caU * rV - caV * rU) / denominator;
    if (t < -GEOMETRY_EPSILON_M || t > 1 + GEOMETRY_EPSILON_M ||
        q < -GEOMETRY_EPSILON_M || q > 1 + GEOMETRY_EPSILON_M) return null;
    return { u: a.u + t * rU, v: a.v + t * rV };
}

function addCriticalU(values, u, minU, maxU) {
    if (u >= minU - GEOMETRY_EPSILON_M && u <= maxU + GEOMETRY_EPSILON_M) {
        values.push(Math.max(minU, Math.min(maxU, u)));
    }
}

function triangleIntervalAtU(triangle, u) {
    const values = [];
    for (let i = 0; i < 3; i++) {
        const a = triangle[i], b = triangle[(i + 1) % 3];
        const du = b.u - a.u;
        if (Math.abs(du) < GEOMETRY_EPSILON_M) {
            if (Math.abs(u - a.u) <= COVERAGE_EPSILON_M) values.push(a.v, b.v);
            continue;
        }
        const t = (u - a.u) / du;
        if (t >= -GEOMETRY_EPSILON_M && t <= 1 + GEOMETRY_EPSILON_M) {
            values.push(a.v + (b.v - a.v) * t);
        }
    }
    if (values.length === 0) return null;
    return [Math.min(...values), Math.max(...values)];
}

function verticalSliceCovered(triangles, u, minV, maxV) {
    const intervals = [];
    for (const triangle of triangles) {
        const b = triangle.bounds || triangleBounds(triangle);
        if (u < b.minU - COVERAGE_EPSILON_M || u > b.maxU + COVERAGE_EPSILON_M ||
            maxV < b.minV - COVERAGE_EPSILON_M || minV > b.maxV + COVERAGE_EPSILON_M) continue;
        const interval = triangleIntervalAtU(triangle, u);
        if (interval) intervals.push(interval);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let coveredTo = minV;
    for (const [start, end] of intervals) {
        if (end < coveredTo - COVERAGE_EPSILON_M) continue;
        if (start > coveredTo + COVERAGE_EPSILON_M) return false;
        coveredTo = Math.max(coveredTo, end);
        if (coveredTo >= maxV - COVERAGE_EPSILON_M) return true;
    }
    return coveredTo >= maxV - COVERAGE_EPSILON_M;
}

function edgeDescriptor(a, b) {
    return {
        a,
        b,
        minU: Math.min(a.u, b.u),
        maxU: Math.max(a.u, b.u),
        minV: Math.min(a.v, b.v),
        maxV: Math.max(a.v, b.v),
    };
}

function* buildCoverageIndexCooperative(triangles) {
    const cached = coverageIndexCache.get(triangles);
    if (cached) return cached;
    const edges = [];
    const criticalU = [];
    let stagedWork = 0;
    for (const triangle of triangles) {
        triangle.bounds = triangle.bounds || triangleBounds(triangle);
        for (const point of triangle) criticalU.push(point.u);
        for (let i = 0; i < 3; i++) {
            edges.push(edgeDescriptor(triangle[i], triangle[(i + 1) % 3]));
        }
        stagedWork += 1;
        if (stagedWork >= COVERAGE_INDEX_WORK_PER_STAGE) {
            stagedWork = 0;
            yield { phase: 'facade-coverage-index' };
        }
    }
    // An edge pair can intersect only while its U extents overlap. Sorting by
    // minU turns the former all-pairs scan into an exact sweep: once a later
    // edge begins beyond this edge's maxU, every following edge can be skipped.
    // The V check removes the remaining disjoint candidates before the more
    // expensive intersection calculation. Neither gate approximates geometry.
    edges.sort((a, b) => a.minU - b.minU || a.minV - b.minV);
    // Edge ordering can change only at an intersection. Cache those positions
    // once per immutable surface rather than repeating it per window.
    for (let i = 0; i < edges.length; i++) {
        const a = edges[i];
        for (let j = i + 1; j < edges.length; j++) {
            const b = edges[j];
            if (b.minU > a.maxU + GEOMETRY_EPSILON_M) break;
            if (b.maxV >= a.minV - GEOMETRY_EPSILON_M
                && b.minV <= a.maxV + GEOMETRY_EPSILON_M) {
                const intersection = edgeIntersection(a.a, a.b, b.a, b.b);
                if (intersection) criticalU.push(intersection.u);
            }
            stagedWork += 1;
            if (stagedWork >= COVERAGE_INDEX_WORK_PER_STAGE) {
                stagedWork = 0;
                yield { phase: 'facade-coverage-index' };
            }
        }
        // Count the sweep advance too. A surface with many mutually disjoint
        // edges has almost no pair candidates, but walking a very large edge
        // list must still remain resumable.
        stagedWork += 1;
        if (stagedWork >= COVERAGE_INDEX_WORK_PER_STAGE) {
            stagedWork = 0;
            yield { phase: 'facade-coverage-index' };
        }
    }
    criticalU.sort((a, b) => a - b);
    const index = { edges, criticalU };
    coverageIndexCache.set(triangles, index);
    return index;
}

function getCoverageIndex(triangles) {
    return drainIterator(buildCoverageIndexCooperative(triangles));
}

export function* prepareFacadeCoverageIndexCooperative(surface) {
    const triangles = surface && surface.triangles;
    if (!Array.isArray(triangles) || triangles.length === 0) return null;
    return yield* buildCoverageIndexCooperative(triangles);
}

// Exact for a piecewise-linear triangle union: all U positions where slice
// topology can change are tested, plus one point in every interval between
// them. No sampling grid can accidentally hop over a narrow roof notch.
const HEAD_SAMPLES = 24;
const HEAD_EDGE_INSET_M = 0.02;
const HEAD_LEVEL_TOLERANCE_M = 0.5;
const HEAD_LEVEL_SLOPE = 0.15;          // ~8.5°: a roof pitch is far steeper, a step is flat
const HEAD_STEP_LEVEL_FRACTION = 0.75;

// The highest point of the surface at each of a set of columns across its width.
function sampleHeadProfile(surface) {
    const width = surface.maxU - surface.minU;
    const profile = [];
    for (let i = 0; i < HEAD_SAMPLES; i++) {
        // The columns reach the wall's edges, where a gable end is at its eaves,
        // but never sit exactly on them: a column on minU/maxU only grazes the
        // edge and its head is not well defined there.
        const inset = Math.min(HEAD_EDGE_INSET_M, width / 4);
        const u = surface.minU + inset
            + (width - 2 * inset) * (i / (HEAD_SAMPLES - 1));
        let head = -Infinity;
        for (const triangle of surface.triangles) {
            for (let e = 0; e < 3; e++) {
                const a = triangle[e];
                const b = triangle[(e + 1) % 3];
                const du = b.u - a.u;
                if (Math.abs(du) < GEOMETRY_EPSILON_M) continue;
                const t = (u - a.u) / du;
                if (t < 0 || t > 1) continue;
                const v = a.v + t * (b.v - a.v);
                if (v > head) head = v;
            }
        }
        if (head > -Infinity) profile.push(head);
    }
    return profile;
}

// The height under which a wall can carry storeys.
//
// A wall's top boundary is one of three things. LEVEL — a flat roof, a parapet,
// the wall under a hip: the whole wall is storeys. STEPPED — a tall block and a
// low wing sharing one plane: still all storeys, and the silhouette mask carves
// out the part that isn't there. SLOPED — a gable end or a mono-pitch: the wedge
// above the eaves is roof, and roof holds no storeys.
//
// Only the sloped case lowers the head, and it lowers it to the eaves. A gable
// end is a vertical wall with a triangular top, so its apex reads as wall height
// unless it is asked whether the head is level; left unasked, the facade grows a
// phantom floor whose middle window lands inside the roof.
export function getFacadeHeadHeight(surface) {
    if (!surface) return 0;
    const profile = sampleHeadProfile(surface);
    if (profile.length === 0) return surface.maxV;
    const headMax = surface.maxV;
    const headMin = Math.min(...profile);
    if (headMax - headMin <= HEAD_LEVEL_TOLERANCE_M) return headMax;
    // Level or sloped? Measured as a gradient, not as a height: a step is flat
    // either side of one riser, while a roof pitch slopes the whole way across.
    // Both drop the head, so height alone cannot tell them apart.
    const du = (surface.maxU - surface.minU) / (profile.length - 1);
    let levelRuns = 0;
    for (let i = 1; i < profile.length; i++) {
        if (Math.abs(profile[i] - profile[i - 1]) <= HEAD_LEVEL_SLOPE * du) levelRuns++;
    }
    if (levelRuns >= (profile.length - 1) * HEAD_STEP_LEVEL_FRACTION) return headMax;
    return headMin;
}

// Clip a world-space triangle to the half-space y <= maxY, so an openings
// overlay can stop at the eaves without a flat quad being substituted for the
// wall: every triangle returned lies exactly on the source triangle's plane.
export function clipTriangleBelowY(triangle, maxY) {
    const inside = triangle.map((point) => point[1] <= maxY);
    if (inside[0] && inside[1] && inside[2]) return [triangle];
    if (!inside[0] && !inside[1] && !inside[2]) return [];
    const polygon = [];
    for (let i = 0; i < 3; i++) {
        const a = triangle[i];
        const b = triangle[(i + 1) % 3];
        if (inside[i]) polygon.push(a);
        if (inside[i] !== inside[(i + 1) % 3]) {
            const t = (maxY - a[1]) / (b[1] - a[1]);
            polygon.push([a[0] + t * (b[0] - a[0]), maxY, a[2] + t * (b[2] - a[2])]);
        }
    }
    const out = [];
    for (let i = 2; i < polygon.length; i++) out.push([polygon[0], polygon[i - 1], polygon[i]]);
    return out;
}

const DUPLICATE_PLANE_GAP_M = 0.12;     // further apart than this and the front wall hides the back one
const DUPLICATE_OVERLAP_M = 0.5;
const DUPLICATE_NORMAL_EPSILON = 0.02;

function surfacesShareOneWall(a, b) {
    if (Math.abs(a.nx - b.nx) > DUPLICATE_NORMAL_EPSILON
        || Math.abs(a.nz - b.nz) > DUPLICATE_NORMAL_EPSILON) return false;
    if (Math.abs(a.d - b.d) > DUPLICATE_PLANE_GAP_M) return false;
    const uOverlap = Math.min(a.maxU, b.maxU) - Math.max(a.minU, b.minU);
    const vOverlap = Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV);
    return uOverlap > DUPLICATE_OVERLAP_M && vOverlap > DUPLICATE_OVERLAP_M;
}

// One facade grid per wall.
//
// A GDI feature can carry the same wall as two overlapping patches at the same
// depth — a duplicated ring, or one wall the connect tolerance split in two.
// Each patch earned its own window grid, and because the openings overlay is
// alpha-TESTED rather than blended, both grids stayed visible: one laid a
// shopfront where the other laid a window, in the same bay, and a facade ended
// up with two front doors.
//
// Patches that overlap at the same depth ARE one wall — no building has two
// walls in the same plane in the same place — so they are merged, and one grid
// is laid across the union. Merged, not discarded: neither patch is wholly
// inside the other, and dropping one would blank the part that sticks out.
//
// Walls further apart than DUPLICATE_PLANE_GAP_M are left alone: a projecting
// bay hides the wall behind it with its own opaque plaster, and that wall's
// exposed flanks still need their own windows. Patches that merely sit side by
// side on one plane are left alone too — they do not overlap, and a window must
// never span the gap between them.
export function mergeDuplicateWallSurfaces(surfaces) {
    if (!Array.isArray(surfaces) || surfaces.length < 2) return surfaces;
    const merged = [];
    for (const surface of surfaces) {
        const host = merged.find((candidate) => surfacesShareOneWall(candidate, surface));
        if (!host) {
            merged.push({
                ...surface,
                triangles: [...surface.triangles],
                worldTriangles: [...surface.worldTriangles],
            });
            continue;
        }
        // Every triangle is CARRIED OVER, never dropped: the two patches are one
        // wall, and the grid is laid across their union. Re-projected onto the
        // host's tangent rather than keeping its own — the two planes agree only
        // to within DUPLICATE_NORMAL_EPSILON, and across a long wall even that
        // much drift would slide the absorbed patch's bays out of the grid it is
        // joining.
        for (const worldTriangle of surface.worldTriangles) {
            host.worldTriangles.push(worldTriangle);
            host.triangles.push(projectTriangle(worldTriangle, host.tx, host.tz));
        }
        const bounds = host.triangles.reduce((result, triangle) => {
            const b = triangleBounds(triangle);
            result.minU = Math.min(result.minU, b.minU);
            result.maxU = Math.max(result.maxU, b.maxU);
            result.minV = Math.min(result.minV, b.minV);
            result.maxV = Math.max(result.maxV, b.maxV);
            return result;
        }, { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity });
        Object.assign(host, bounds);
    }
    return merged.length === surfaces.length ? surfaces : merged;
}

const SHARED_WALL_COPLANAR_M = 0.03;    // any further apart and the front wall's own plaster settles it
const SHARED_WALL_TALLER_M = 0.5;       // "taller" must mean taller, not a modelling wobble
const SHARED_WALL_OVERLAP_M = 0.5;
const SHARED_WALL_NORMAL_EPSILON = 0.02;
const SHARED_WALL_BUCKET = 0.05;

function sharedWallBucketKey(nx, nz) {
    return `${Math.round(nx / SHARED_WALL_BUCKET)},${Math.round(nz / SHARED_WALL_BUCKET)}`;
}

// Every wall in the tile, bucketed by plane, so a wall can be asked what else
// stands exactly where it stands.
export function buildSharedWallIndex(wallFaces) {
    const buckets = new Map();
    for (const face of wallFaces || []) {
        const key = sharedWallBucketKey(face.nx, face.nz);
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push(face);
    }
    return buckets;
}

// Is this wall the SHORT copy of a wall another building models taller?
//
// GDI gives a ground-floor annex its own object, and that object carries the main
// building's street wall a second time — same plane, same place, only 5 m tall. Both
// copies earned a facade grid, and the short one's grid is a ground floor and nothing
// else, so the two ground floors landed on each other AT THE SAME DEPTH and z-fought:
// the flickering double shopfront, showing more of one or the other as the camera moved.
//
// The caller's answer to this is NOT to drop a grid — a dropped grid can leave a wall
// with no facade at all, and a wall that sticks out past the taller one still needs its
// windows. It is to push this wall a few centimetres into its own solid, so the taller
// wall wins the depth test outright. The short wall keeps its grid and still paints
// wherever the taller one does not cover it.
//
// Only walls within SHARED_WALL_COPLANAR_M are judged. Give them any real gap and the
// front wall's own opaque plaster already settles which facade you see.
export function wallFaceIsShortCopy(index, face, objectKey) {
    if (!index || !face) return false;
    const nxq = Math.round(face.nx / SHARED_WALL_BUCKET);
    const nzq = Math.round(face.nz / SHARED_WALL_BUCKET);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const list = index.get(`${nxq + dx},${nzq + dz}`);
            if (!list) continue;
            for (const other of list) {
                if (other.objectId === objectKey) continue;
                if (other.vMax < face.vMax + SHARED_WALL_TALLER_M) continue;
                if (Math.abs(other.nx - face.nx) > SHARED_WALL_NORMAL_EPSILON
                    || Math.abs(other.nz - face.nz) > SHARED_WALL_NORMAL_EPSILON) continue;
                if (Math.abs(other.d - face.d) > SHARED_WALL_COPLANAR_M) continue;
                const overlap = Math.min(other.uMax, face.uMax) - Math.max(other.uMin, face.uMin);
                if (overlap > SHARED_WALL_OVERLAP_M) return true;
            }
        }
    }
    return false;
}

// How far in front of a wall another wall may stand and still count as
// covering it. Double-shell GDI walls and re-carried street walls sit
// 0.05–0.5 m apart; the geometry inset hides the back shell only while depth
// precision holds — from afar the polygon-offset overlay pulls through the
// front wall and the facade shows two overlapping opening grids.
const COVERING_WALL_MAX_GAP_M = 0.9;
// Plane fits of the SAME physical wall differ by a few centimetres between
// the per-face and per-surface passes (warped GDI rings, tolerant best-fit).
// Bands must respect that noise: cross-object walls within the tie epsilon
// are duplicate data entries resolved by object id; genuine front shells
// start beyond it; and a surface's own re-fitted faces must never read as
// "in front" of themselves, hence the wider same-object threshold.
const CROSS_OBJECT_TIE_EPS_M = 0.05;
const SAME_OBJECT_MIN_FRONT_M = 0.10;

// The u/v extents of every wall covering `face`: either standing IN FRONT of
// it (any object, including this face's own building — double shells), or
// coplanar with it but decisively TALLER (another object re-carrying this
// street wall, the wallFaceIsShortCopy case). A covered region must never be
// painted with openings — hiding it with depth alone fails at distance.
export function tallerWallCoverageRects(index, face, objectKey) {
    if (!index || !face) return null;
    let rects = null;
    // Canonical plane normal is sign-normalised, so outward direction comes
    // from interiorSide: outward = -interiorSide * (nx, nz). "In front" means
    // further along outward.
    const outwardSign = -(face.interiorSide || 1);
    const nxq = Math.round(face.nx / SHARED_WALL_BUCKET);
    const nzq = Math.round(face.nz / SHARED_WALL_BUCKET);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const list = index.get(`${nxq + dx},${nzq + dz}`);
            if (!list) continue;
            for (const other of list) {
                if (Math.abs(other.nx - face.nx) > SHARED_WALL_NORMAL_EPSILON
                    || Math.abs(other.nz - face.nz) > SHARED_WALL_NORMAL_EPSILON) continue;
                const sameObject = other.objectId === objectKey;
                const frontGap = (other.d - face.d) * outwardSign;
                const gapAbs = Math.abs(other.d - face.d);
                // A covering element must be WALL-like. Balcony parapets,
                // cornice bands and string courses stand 0.1–0.9 m proud of
                // big facades in strips under ~1.5 m tall — they decorate the
                // wall behind, they do not hide it.
                const wallLike = (other.vMax - other.vMin) >= 2.5;
                let covers = false;
                if (sameObject) {
                    // Double-shell wall within one object. The threshold sits
                    // above fit noise so a surface's own faces never block it.
                    covers = wallLike
                        && frontGap > SAME_OBJECT_MIN_FRONT_M
                        && frontGap <= COVERING_WALL_MAX_GAP_M;
                } else if (gapAbs <= SHARED_WALL_COPLANAR_M
                    && other.vMax >= face.vMax + SHARED_WALL_TALLER_M) {
                    // Another object re-carrying this wall, decisively taller
                    // — the taller wall owns the grid (short-copy case).
                    covers = true;
                } else if (gapAbs <= CROSS_OBJECT_TIE_EPS_M
                    && Math.abs(other.vMax - face.vMax) < SHARED_WALL_TALLER_M) {
                    // Whole buildings double-entered in GDI: the same wall
                    // twice, coplanar within noise, equally tall. Two
                    // alpha-tested grids on one plane z-fight per viewing
                    // angle, so exactly ONE copy may paint — deterministic
                    // winner by object id.
                    covers = String(other.objectId) < String(objectKey);
                } else {
                    covers = wallLike
                        && frontGap > CROSS_OBJECT_TIE_EPS_M
                        && frontGap <= COVERING_WALL_MAX_GAP_M;
                }
                if (!covers) continue;
                if (other.vMax < face.vMin + SHARED_WALL_OVERLAP_M) continue;
                const overlap = Math.min(other.uMax, face.uMax) - Math.max(other.uMin, face.uMin);
                if (overlap <= SHARED_WALL_OVERLAP_M) continue;
                if (!rects) rects = [];
                rects.push({
                    minU: other.uMin,
                    maxU: other.uMax,
                    minV: other.vMin,
                    maxV: other.vMax,
                });
            }
        }
    }
    return rects;
}

export function rectangleFullyCoveredByTriangles(rect, supportTriangles) {
    if (!rect || !Number.isFinite(rect.minU) || !Number.isFinite(rect.maxU) ||
        !Number.isFinite(rect.minV) || !Number.isFinite(rect.maxV) ||
        rect.maxU <= rect.minU || rect.maxV <= rect.minV) return false;
    const allTriangles = supportTriangles || [];
    const triangles = allTriangles.filter((triangle) => {
        const b = triangle.bounds || triangleBounds(triangle);
        triangle.bounds = b;
        return b.maxU >= rect.minU - COVERAGE_EPSILON_M &&
            b.minU <= rect.maxU + COVERAGE_EPSILON_M &&
            b.maxV >= rect.minV - COVERAGE_EPSILON_M &&
            b.minV <= rect.maxV + COVERAGE_EPSILON_M;
    });
    if (triangles.length === 0) return false;

    const coverageIndex = getCoverageIndex(allTriangles);
    const critical = [rect.minU, rect.maxU];
    for (const u of coverageIndex.criticalU) {
        if (u < rect.minU - GEOMETRY_EPSILON_M) continue;
        if (u > rect.maxU + GEOMETRY_EPSILON_M) break;
        addCriticalU(critical, u, rect.minU, rect.maxU);
    }
    for (const edge of coverageIndex.edges) {
        if (edge.maxU < rect.minU - GEOMETRY_EPSILON_M) continue;
        if (edge.minU > rect.maxU + GEOMETRY_EPSILON_M) break;
        const { a, b } = edge;
        const dv = b.v - a.v;
        if (Math.abs(dv) > GEOMETRY_EPSILON_M) {
            for (const boundaryV of [rect.minV, rect.maxV]) {
                if (boundaryV < edge.minV - GEOMETRY_EPSILON_M
                    || boundaryV > edge.maxV + GEOMETRY_EPSILON_M) continue;
                const t = (boundaryV - a.v) / dv;
                if (t >= -GEOMETRY_EPSILON_M && t <= 1 + GEOMETRY_EPSILON_M) {
                    addCriticalU(critical, a.u + (b.u - a.u) * t, rect.minU, rect.maxU);
                }
            }
        }
    }
    critical.sort((a, b) => a - b);
    const unique = critical.filter((u, index) => index === 0 || u - critical[index - 1] > GEOMETRY_EPSILON_M);
    const probes = unique.slice();
    for (let i = 0; i < unique.length - 1; i++) {
        if (unique[i + 1] - unique[i] > GEOMETRY_EPSILON_M) probes.push((unique[i] + unique[i + 1]) / 2);
    }
    return probes.every((u) => verticalSliceCovered(triangles, u, rect.minV, rect.maxV));
}

export function rectangleFullyCoveredBySurface(surface, rect) {
    return !!surface && rectangleFullyCoveredByTriangles(rect, surface.triangles);
}
