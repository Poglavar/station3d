// Thin detail follows the upper envelope of the actual published receiver
// facets. Sampling only the input vertices makes a stripe's chord cut through
// a ridge, even when all three samples are individually correct.
export const RECEIVER_DETAIL_LIMITS = Object.freeze({ maxSourceTriangles: 65536,
    // Bound raw spatial-query work separately from the faces that actually
    // intersect one source triangle and enter the pairwise envelope solver.
    maxQuerySteps: 4194304,
    maxCandidateTriangles: 256, maxFragments: 1024, maxOutputVertices: 1048576,
    maxComparisons: 4194304 });

const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const finite = Number.isFinite;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const capacity = message => fail('ground-detail-capacity', message);
const boundsOf = points => ({ minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minZ: Math.min(...points.map(p => p.z)), maxZ: Math.max(...points.map(p => p.z)) });
const overlaps = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
const hasArea = poly => {
    let area = 0;
    for (let i = 1; i + 1 < poly.length; i++) area += cross(poly[0], poly[i], poly[i + 1]);
    return area > 1e-12;
};

// A convex polygon split by a signed half-plane. Preserve the intersection
// identically in both halves so subtracting an occluder cannot create a seam.
function split(poly, distance) {
    const inside = [], outside = [];
    let previous = poly[poly.length - 1], pd = distance(previous);
    for (const point of poly) {
        const d = distance(point);
        if (pd < 0 && d > 0 || pd > 0 && d < 0) {
            const t = pd / (pd - d);
            const intersection = { x: previous.x + (point.x - previous.x) * t,
                z: previous.z + (point.z - previous.z) * t };
            inside.push(intersection); outside.push(intersection);
        }
        if (d >= 0) inside.push(point);
        if (d <= 0) outside.push(point);
        previous = point; pd = d;
    }
    return { inside, outside };
}

function clip(poly, boundary) {
    for (let i = 0; i < boundary.length && poly.length >= 3; i++) {
        const a = boundary[i], b = boundary[(i + 1) % boundary.length];
        if (a.x === b.x && a.z === b.z) continue;
        poly = split(poly, p => cross(a, b, p)).inside;
    }
    return hasArea(poly) ? poly : [];
}

function subtract(poly, boundary) {
    const retained = [];
    for (let i = 0; i < boundary.length && poly.length >= 3; i++) {
        const a = boundary[i], b = boundary[(i + 1) % boundary.length];
        if (a.x === b.x && a.z === b.z) continue;
        const halves = split(poly, p => cross(a, b, p));
        // Shared edges have zero area. Retaining them as polygons duplicates
        // them at every later subtraction and can exhaust fragment capacity
        // even though the final visible footprint is tiny.
        if (hasArea(halves.outside)) retained.push(halves.outside);
        poly = halves.inside;
    }
    return retained;
}

function receiverFace(candidate) {
    const { positions: p, a, b, c, originX = 0, originZ = 0 } = candidate;
    const points = [a, b, c].map(i => ({ x: p[i] + originX, y: p[i + 1], z: p[i + 2] + originZ }));
    if (!points.every(p => [p.x, p.y, p.z].every(finite))) throw new TypeError('Receiver detail requires finite facets');
    let area = cross(...points);
    // Vertical walls have no XZ footprint. Candidate providers select the
    // eligible level/material; winding may be either direction on double-sided
    // legacy road tops. Geometry, rather than vertex normals, defines the plane.
    if (Math.abs(area) < 1e-12) return null;
    if (area < 0) { [points[1], points[2]] = [points[2], points[1]]; area = -area; }
    const [pa, pb, pc] = points;
    return { points, bounds: boundsOf(points), yAt: p => pa.y
        + cross(pa, p, pc) / area * (pb.y - pa.y)
        + cross(pa, pb, p) / area * (pc.y - pa.y) };
}

// receiverTriangles(bounds) is a spatially bounded iterable of immutable
// geometry references {positions, a, b, c, originX?, originZ?}; a/b/c are
// attribute offsets. It may yield null to let a sparse provider share the
// cooperative budget. Input footprints and queries use scene coordinates;
// output Float32 positions are relative to the requested storage origin. The
// caller keeps its publication revision current and places the resulting mesh.
export function* projectReceiverDetailSteps({ vertices, attributes = null, receiverTriangles, offsetM = .002,
    originX = 0, originZ = 0,
    limits = RECEIVER_DETAIL_LIMITS, now = () => performance.now(), isCurrent = () => true } = {}) {
    if ((!Array.isArray(vertices) && !ArrayBuffer.isView(vertices)) || vertices.length % 9
        || typeof receiverTriangles !== 'function' || !finite(offsetM) || offsetM < 0
        || !finite(originX) || !finite(originZ)
        || !Object.keys(RECEIVER_DETAIL_LIMITS).every(key => Number.isSafeInteger(limits?.[key]) && limits[key] > 0)) {
        throw new TypeError('Receiver detail requires triangles, a receiver query and finite capacities');
    }
    const sourceVertexCount = vertices.length / 3;
    const attributeEntries = Object.entries(attributes || {}).map(([name, descriptor]) => {
        const array = descriptor?.array ?? descriptor;
        const itemSize = Number(descriptor?.itemSize ?? (name === 'uv' ? 2 : 0));
        if ((!Array.isArray(array) && !ArrayBuffer.isView(array))
            || !Number.isSafeInteger(itemSize) || itemSize <= 0
            || array.length !== sourceVertexCount * itemSize) {
            throw new TypeError(`Receiver detail attribute ${name} does not match its source vertices`);
        }
        return { name, array, itemSize };
    });
    if (vertices.length / 9 > limits.maxSourceTriangles) capacity('Detail source triangle capacity exceeded');
    let deadline = now() + .5, comparisons = 0, querySteps = 0;
    let candidateCount = 0, peakCandidates = 0, intersectingCount = 0, peakIntersectingCandidates = 0, peakFragments = 0;
    const output = [];
    const outputAttributes = Object.fromEntries(attributeEntries.map(({ name }) => [name, []]));
    const check = () => { if (!isCurrent()) fail('ground-generation-stale', 'Detail receiver generation changed'); };
    function* budget() {
        if (now() >= deadline) { yield { phase: 'receiver-detail' }; check(); deadline = now() + .5; }
    }
    // Publications cannot interleave inside a synchronous slice. Revalidate
    // after every yield, not by repeating world readiness queries per fragment.
    check();
    for (let offset = 0; offset < vertices.length; offset += 9) {
        yield* budget();
        const source = [0, 3, 6].map((k, sourceIndex) => ({
            x: vertices[offset + k],
            z: vertices[offset + k + 2],
            sourceIndex,
        }));
        if (!source.every(p => finite(p.x) && finite(p.z))) throw new TypeError('Detail footprint must be finite');
        if (Math.abs(cross(...source)) < 1e-12) continue;
        if (cross(...source) < 0) [source[1], source[2]] = [source[2], source[1]];
        const bounds = boundsOf(source), faces = [];
        let candidates = 0;
        for (const candidate of receiverTriangles(bounds)) {
            yield* budget();
            // Count cooperative/null records too: an empty spatial query must
            // still terminate within a finite amount of construction work.
            if (++querySteps > limits.maxQuerySteps) capacity('Detail receiver query work capacity exceeded');
            if (!candidate) continue;
            candidates++;
            const face = receiverFace(candidate);
            if (!face || !overlaps(bounds, face.bounds)) continue;
            face.footprint = clip(source, face.points);
            if (face.footprint.length < 3) continue;
            if (faces.length >= limits.maxCandidateTriangles) capacity(
                `Detail receiver candidate capacity exceeded (intersecting ${faces.length + 1}, queried ${candidates}, source ${offset / 9})`);
            face.bounds = boundsOf(face.footprint);
            faces.push(face);
        }
        candidateCount += candidates; peakCandidates = Math.max(peakCandidates, candidates);
        intersectingCount += faces.length; peakIntersectingCandidates = Math.max(peakIntersectingCandidates, faces.length);
        for (let i = 0; i < faces.length; i++) {
            const face = faces[i];
            let fragments = [face.footprint];
            // Clip at BOTH footprint boundaries and plane intersections. A
            // lower receiver is removed even where it becomes higher halfway
            // across a stripe. Coincident sources have one deterministic owner.
            for (let j = 0; j < faces.length && fragments.length; j++) {
                yield* budget();
                if (j === i || !overlaps(face.bounds, faces[j].bounds)) continue;
                if (++comparisons > limits.maxComparisons) capacity('Detail intersection work capacity exceeded');
                const other = faces[j];
                const differences = other.footprint.map(p => other.yAt(p) - face.yAt(p));
                const coplanar = differences.every(d => Math.abs(d) <= 1e-9);
                if (coplanar && j > i || !coplanar && differences.every(d => d <= 0)) continue;
                const occluder = coplanar ? other.footprint
                    : split(other.footprint, p => other.yAt(p) - face.yAt(p)).inside;
                if (!hasArea(occluder)) continue;
                const retained = [];
                for (const fragment of fragments) {
                    yield* budget();
                    for (const part of subtract(fragment, occluder)) {
                        if (retained.length >= limits.maxFragments) capacity('Detail fragment capacity exceeded');
                        retained.push(part);
                    }
                }
                fragments = retained; peakFragments = Math.max(peakFragments, fragments.length);
            }
            for (const fragment of fragments) for (let k = 1; k + 1 < fragment.length; k++) {
                yield* budget();
                // Store XZ first, then interpolate Y at those actual Float32
                // coordinates. Independent horizontal rounding used to leave
                // detail very slightly underneath sloping receivers.
                const triangle = [fragment[0], fragment[k], fragment[k + 1]]
                    .map(p => ({ x: Math.fround(p.x - originX), z: Math.fround(p.z - originZ) }));
                if (cross(...triangle) <= 1e-12) continue;
                if (output.length / 3 + 3 > limits.maxOutputVertices) capacity('Detail output vertex capacity exceeded');
                for (const point of [triangle[0], triangle[2], triangle[1]]) {
                    const y = Math.fround(face.yAt({ x: point.x + originX, z: point.z + originZ }) + offsetM);
                    if (!finite(y)) throw new TypeError('Detail projection produced a nonfinite height');
                    output.push(point.x, y, point.z);
                    const absolutePoint = { x: point.x + originX, z: point.z + originZ };
                    const area = cross(source[0], source[1], source[2]);
                    const weights = [
                        cross(absolutePoint, source[1], source[2]) / area,
                        cross(source[0], absolutePoint, source[2]) / area,
                        cross(source[0], source[1], absolutePoint) / area,
                    ];
                    for (const attribute of attributeEntries) {
                        const target = outputAttributes[attribute.name];
                        const sourceVertex = offset / 3;
                        for (let component = 0; component < attribute.itemSize; component++) {
                            let value = 0;
                            for (let sourceIndex = 0; sourceIndex < 3; sourceIndex++) {
                                value += weights[sourceIndex] * attribute.array[
                                    (sourceVertex + source[sourceIndex].sourceIndex) * attribute.itemSize + component
                                ];
                            }
                            if (!finite(value)) throw new TypeError('Detail projection produced a nonfinite attribute');
                            target.push(value);
                        }
                    }
                }
            }
        }
    }
    check();
    return { positions: output, attributes: outputAttributes, originX, originZ,
        usage: Object.freeze({ sourceTriangles: vertices.length / 9,
        querySteps, candidateCount, peakCandidates, intersectingCount, peakIntersectingCandidates,
        comparisons, peakFragments, outputVertices: output.length / 3 }) };
}
