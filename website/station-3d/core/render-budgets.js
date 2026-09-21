// Pure geometry-budget helpers shared by streamed 3D layers. They keep
// procedural detail proportional to the visible window and remain testable
// without Three.js, a canvas, or a browser.

import { finiteOrNull } from './math.js';

function finitePositive(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function surfaceRefinementEdgeForArea(areaM2, {
    baseEdgeM = 8,
    maxTriangles = 20_000,
    maxEdgeM = 64,
} = {}) {
    const base = finitePositive(baseEdgeM, 8);
    const ceiling = Math.max(base, finitePositive(maxEdgeM, 64));
    const area = Number(areaM2);
    if (!Number.isFinite(area) || area <= 0) return base;
    const triangleBudget = finitePositive(maxTriangles, 20_000);
    // An equilateral triangle is a useful scale estimate. Renderers that need
    // a hard limit pass the same budget to their triangulator as well.
    const budgetEdge = Math.sqrt((4 * area) / (Math.sqrt(3) * triangleBudget));
    return Math.min(ceiling, Math.max(base, budgetEdge));
}

export function sampleSpacingForBudget(areaM2, {
    baseSpacingM,
    acceptanceChance = 1,
    maxPoints,
    maxSpacingM = 96,
} = {}) {
    const base = finitePositive(baseSpacingM, 1);
    const ceiling = Math.max(base, finitePositive(maxSpacingM, 96));
    const area = Number(areaM2);
    const limit = Number(maxPoints);
    if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(limit) || limit <= 0) {
        return base;
    }
    const chance = Math.max(0, Math.min(1, Number(acceptanceChance) || 0));
    const budgetSpacing = Math.sqrt((area * chance) / limit);
    return Math.min(ceiling, Math.max(base, budgetSpacing));
}

export function isPointWithinRenderWindow(
    x,
    z,
    centerX = 0,
    centerZ = 0,
    radiusM = Infinity,
) {
    const radius = Number(radiusM);
    if (!Number.isFinite(radius)) return radius === Infinity;
    if (radius < 0) return false;
    const dx = Number(x) - Number(centerX);
    const dz = Number(z) - Number(centerZ);
    return Number.isFinite(dx) && Number.isFinite(dz) && dx * dx + dz * dz <= radius * radius;
}

// Sutherland–Hodgman clip of one ring ({x,z} points, unclosed) to the axis-
// aligned square window centered on (centerX, centerZ). Streamed surface
// layers clip their source polygons to the visible window BEFORE spending a
// triangle budget on them: a 9 km² mountain-park polygon is mostly fog-hidden,
// and refining the whole thing exhausts the budget while the ear-clip giants
// it leaves behind drape across valleys as floating slabs. A concave input can
// produce disconnected pieces joined by doubled window edges. Consumers that
// require simple polygons must normalize that path before triangulating it.
export function clipRingToWindow(ring, centerX, centerZ, halfSizeM) {
    const steps = clipRingToWindowSteps(ring, centerX, centerZ, halfSizeM, { now: () => 0 });
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* clipRingToWindowSteps(ring, centerX, centerZ, halfSizeM, {
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    const check = () => {
        if (!isCurrent()) throw Object.assign(new Error('Polygon clipping was superseded'), { code: 'ground-topology-stale' });
    };
    let deadline = now() + .5;
    const half = Number(halfSizeM);
    if (!Number.isFinite(half) || half <= 0) return [];
    // finiteOrNull, not Number(): a {x: null} point must be dropped, never
    // coerced to the origin.
    let points = [];
    for (const point of ring || []) {
        check();
        if (now() >= deadline) { yield { phase: 'ground-clip-source' }; check(); deadline = now() + .5; }
        const x = finiteOrNull(point?.x), z = finiteOrNull(point?.z);
        if (x !== null && z !== null) points.push({ x, z });
    }
    const edges = [
        { axis: 'x', sign: 1, limit: Number(centerX) + half },
        { axis: 'x', sign: -1, limit: Number(centerX) - half },
        { axis: 'z', sign: 1, limit: Number(centerZ) + half },
        { axis: 'z', sign: -1, limit: Number(centerZ) - half },
    ];
    for (const { axis, sign, limit } of edges) {
        if (points.length < 3) return [];
        const inside = (point) => (sign > 0 ? point[axis] <= limit : point[axis] >= limit);
        const clipped = [];
        for (let index = 0; index < points.length; index++) {
            check();
            if (now() >= deadline) { yield { phase: 'ground-clip-window' }; check(); deadline = now() + .5; }
            const current = points[index];
            const previous = points[(index + points.length - 1) % points.length];
            const currentInside = inside(current);
            if (inside(previous) !== currentInside) {
                const t = (limit - previous[axis]) / (current[axis] - previous[axis]);
                clipped.push({
                    x: previous.x + (current.x - previous.x) * t,
                    z: previous.z + (current.z - previous.z) * t,
                });
            }
            if (currentInside) clipped.push(current);
        }
        points = clipped;
    }
    return points.length >= 3 ? points : [];
}

export function boundsIntersectRenderWindow(
    bounds,
    centerX = 0,
    centerZ = 0,
    radiusM = Infinity,
) {
    if (!bounds) return false;
    const radius = Number(radiusM);
    if (!Number.isFinite(radius)) return radius === Infinity;
    if (radius < 0) return false;
    const minX = Number(bounds.minX);
    const maxX = Number(bounds.maxX);
    const minZ = Number(bounds.minZ);
    const maxZ = Number(bounds.maxZ);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return false;
    const closestX = Math.max(minX, Math.min(maxX, Number(centerX)));
    const closestZ = Math.max(minZ, Math.min(maxZ, Number(centerZ)));
    return isPointWithinRenderWindow(closestX, closestZ, centerX, centerZ, radius);
}

export function filterTrianglePositionsByRenderWindow(
    positions, centerX = 0, centerZ = 0, radiusM = Infinity,
) {
    const steps = filterTrianglePositionsByRenderWindowSteps(positions, centerX, centerZ, radiusM);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* filterTrianglePositionsByRenderWindowSteps(
    positions,
    centerX = 0,
    centerZ = 0,
    radiusM = Infinity,
) {
    const source = Array.isArray(positions) || ArrayBuffer.isView(positions) ? positions : [];
    const filtered = [];
    for (let offset = 0; offset + 8 < source.length; offset += 9) {
        if (offset % (64 * 9) === 0) yield { phase: 'filter-wall-triangles', triangle: offset / 9 };
        const centroidX = (source[offset] + source[offset + 3] + source[offset + 6]) / 3;
        const centroidZ = (source[offset + 2] + source[offset + 5] + source[offset + 8]) / 3;
        if (!isPointWithinRenderWindow(centroidX, centroidZ, centerX, centerZ, radiusM)) continue;
        for (let index = 0; index < 9; index++) filtered.push(source[offset + index]);
    }
    return filtered;
}

// Same window filter for unindexed triangles that carry per-vertex UVs: both
// arrays are culled in lockstep (9 position floats ↔ 6 uv floats per triangle),
// so an attribute can never slip against its triangle.
export function filterTriangleGeometryByRenderWindow(
    geometry = {}, centerX = 0, centerZ = 0, radiusM = Infinity,
) {
    const steps = filterTriangleGeometryByRenderWindowSteps(geometry, centerX, centerZ, radiusM);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* filterTriangleGeometryByRenderWindowSteps(
    { positions, uvs } = {},
    centerX = 0,
    centerZ = 0,
    radiusM = Infinity,
) {
    const source = Array.isArray(positions) || ArrayBuffer.isView(positions) ? positions : [];
    const sourceUvs = Array.isArray(uvs) || ArrayBuffer.isView(uvs) ? uvs : [];
    const filtered = [];
    const filteredUvs = [];
    for (let offset = 0; offset + 8 < source.length; offset += 9) {
        if (offset % (64 * 9) === 0) yield { phase: 'filter-collar-triangles', triangle: offset / 9 };
        const centroidX = (source[offset] + source[offset + 3] + source[offset + 6]) / 3;
        const centroidZ = (source[offset + 2] + source[offset + 5] + source[offset + 8]) / 3;
        if (!isPointWithinRenderWindow(centroidX, centroidZ, centerX, centerZ, radiusM)) continue;
        for (let index = 0; index < 9; index++) filtered.push(source[offset + index]);
        const uvOffset = (offset / 9) * 6;
        for (let index = 0; index < 6; index++) filteredUvs.push(sourceUvs[uvOffset + index]);
    }
    return { positions: filtered, uvs: filteredUvs };
}
