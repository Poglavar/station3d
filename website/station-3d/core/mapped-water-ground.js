// Vector water and its terrain opening share the actual stored surface faces.
// Clip to the simulation window before the Boolean kernel; remote coastline
// coordinates must not consume the local kernel's precision or capacity.
import { clipRingToWindowSteps } from './render-budgets.js';
import { triangulateReceiverPolygonsSteps } from './terrain-cutout-topology.js';
import { captureBackedOpeningTrianglesSteps } from './backed-opening-triangles.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function* compileMappedWaterSurfaceSteps({ coastline, centerX, centerZ, halfSizeM, seaY,
    limits, now = () => performance.now(), isCurrent = () => true }) {
    if (![centerX, centerZ, halfSizeM, seaY].every(Number.isFinite) || halfSizeM <= 0 || halfSizeM > 2048
        || !Array.isArray(coastline?.features)
        || !['maxSourceVertices', 'maxOperandVertices', 'maxIntersections', 'maxOutputTriangles']
            .every(key => Number.isSafeInteger(limits?.[key]) && limits[key] > 0)) {
        throw new TypeError('Mapped water requires a bounded simulation window and source');
    }
    let deadline = now() + .5, vertices = 0;
    const check = () => { if (!isCurrent()) fail('ground-generation-stale', 'Mapped water preparation expired'); };
    function* step() { check(); if (now() >= deadline) { yield { phase: 'mapped-water-source' }; deadline = now() + .5; } }
    const polygons = [];
    for (const feature of coastline.features) {
        const rings = [];
        for (const [index, ring] of feature.rings.entries()) {
            vertices += ring.length;
            if (vertices > limits.maxSourceVertices) fail('ground-generation-capacity', 'Mapped water source exceeds capacity');
            const points = [];
            for (const p of ring) {
                yield* step();
                if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) throw new TypeError('Mapped water requires finite source vertices');
                points.push({ x: p[0], z: p[1] });
            }
            const clipped = yield* clipRingToWindowSteps(points, centerX, centerZ, halfSizeM, { now, isCurrent });
            if (clipped.length < 3) { if (index === 0) break; continue; }
            const local = [];
            for (const p of clipped) {
                yield* step();
                // Triangulate the stored boundary, so an almost-collinear
                // coast vertex cannot flip/collapse a face only at upload.
                const x = Math.fround(p.x - centerX), z = Math.fround(p.z - centerZ);
                if (Math.max(Math.abs(x + centerX - p.x), Math.abs(z + centerZ - p.z)) > .001) {
                    fail('ground-receiver-precision', 'Mapped water boundary exceeds one millimetre of storage error');
                }
                local.push([x, z]);
            }
            rings.push(local);
        }
        if (rings.length) polygons.push(rings);
    }
    const faces = yield* triangulateReceiverPolygonsSteps({ polygons, limits, now, isCurrent });
    const positions = new Float32Array(faces.length * 9), normals = new Float32Array(positions.length);
    let offset = 0;
    for (const face of faces) {
        yield* step();
        // The shared triangulator winds counterclockwise in x/z; Three's
        // upward normal needs the opposite order. Round once, at GPU storage.
        for (const p of [face[0], face[2], face[1]]) {
            const point = [p[0], seaY, p[1]];
            for (let axis = 0; axis < 3; axis++) {
                positions[offset + axis] = point[axis];
                if (Math.abs(positions[offset + axis] - point[axis]) > .001) {
                    fail('ground-receiver-precision', 'Mapped water exceeds one millimetre of storage error');
                }
            }
            normals[offset + 1] = 1; offset += 3;
        }
        const i = offset - 9;
        const up = (positions[i + 5] - positions[i + 2]) * (positions[i + 6] - positions[i])
            - (positions[i + 3] - positions[i]) * (positions[i + 8] - positions[i + 2]);
        if (!(up > 0)) fail('ground-receiver-precision', 'Mapped water face collapsed in storage');
    }
    check(); return Object.freeze({ positions, normals, originX: centerX, originZ: centerZ, triangleCount: faces.length });
}

export function* captureMappedWaterOpeningsSteps({ surfaces, replacementKey, limits,
    now = () => performance.now(), isCurrent = () => true }) {
    let count = 0, deadline = now() + .5;
    const budget = {
        check() { if (!isCurrent()) fail('ground-generation-stale', 'Water opening preparation expired'); },
        take() { if (++count > limits.maxRegions || count * 3 > limits.maxSourceVertices) fail('ground-opening-capacity', 'Water openings exceed capacity'); },
        *step(phase) { this.check(); if (now() >= deadline) { yield { phase }; deadline = now() + .5; } },
    };
    const regions = [];
    for (const { positions, indices: sourceIndices, originX = 0, originZ = 0 } of surfaces) {
        const vertexCount = positions.length / 3, length = sourceIndices?.length ?? vertexCount;
        if (length % 3 || length / 3 > limits.maxRegions) fail('ground-opening-capacity', 'Water receiver exceeds face capacity');
        const indices = sourceIndices || new Uint32Array(length), faceOffsets = [];
        for (let i = 0; i < length; i += 3) {
            yield* budget.step('water-opening-faces');
            if (!sourceIndices) { indices[i] = i; indices[i + 1] = i + 1; indices[i + 2] = i + 2; }
            const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
            const up = (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a])
                - (positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]);
            if (up > 0) faceOffsets.push(i);
        }
        const captured = yield* captureBackedOpeningTrianglesSteps({ positions, indices, faceOffsets, originX, originZ,
            kind: 'mapped-water', replacementKey, maxY: null, budget });
        for (const region of captured) { yield* budget.step('water-opening-regions'); regions.push(region); }
    }
    budget.check(); return Object.freeze(regions);
}

export function* sameMappedWaterGeometrySteps(a, b, isCurrent) {
    if (!a || !b) return false;
    for (const key of ['originX', 'originZ']) {
        if (a.sea[key] !== b.sea[key] || a.geometry[key] !== b.geometry[key]) return false;
    }
    const arrays = [
        [a.sea.positions, b.sea.positions], [a.sea.normals, b.sea.normals],
        ...['collarPositions', 'collarNormals', 'collarUvs', 'wallPositions', 'wallNormals']
            .map(key => [a.geometry[key], b.geometry[key]]),
    ];
    for (const [left, right] of arrays) {
        if (left.length !== right.length) return false;
        for (let start = 0; start < left.length; start += 512) {
            if (!isCurrent()) fail('ground-generation-stale', 'Coast geometry comparison expired');
            for (let i = start; i < Math.min(start + 512, left.length); i++) if (left[i] !== right[i]) return false;
            yield { phase: 'water-geometry-reuse' };
        }
    }
    return true;
}
