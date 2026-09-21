// OSM land-use tags describe a material, not necessarily a constructed edge.
// Add decorative edging for surfaces that normally have an explicit perimeter;
// ordinary grass is terrain and does not imply a curb. Street and sidewalk
// curbs remain owned by the road curb system.

const PHYSICALLY_EDGED_SURFACE_TYPES = Object.freeze([
    'flowerbed',
    'paving',
    'sand',
    'playground',
    'fitness',
]);

export function decorSurfaceEdgingTypeIndex(surfaceType) {
    return PHYSICALLY_EDGED_SURFACE_TYPES.indexOf(String(surfaceType || ''));
}

export function decorSurfaceNeedsPhysicalEdging(surfaceType) {
    return decorSurfaceEdgingTypeIndex(surfaceType) >= 0;
}

// The same clamped miter as the dressing mesh, expressed as bounded X/Z
// polygons. No terrain samples or technical Y offsets belong to this source.
// Holes get their own boundary band; their interiors remain unpainted.
export function* decorSurfaceEdgingPolygonsSteps(rings, { width = 0.14, segmentsPerStep = 128 } = {}) {
    if (!Number.isFinite(width) || width <= 0 || !Number.isSafeInteger(segmentsPerStep)
        || segmentsPerStep < 1 || segmentsPerStep > 128) throw new TypeError('Invalid edging paint limits');
    let polygons = [];
    const sidePoints = (ring, i, n) => {
        const prev = ring[(i + n - 1) % n], cur = ring[i], next = ring[(i + 1) % n];
        if (![prev.x, prev.z, cur.x, cur.z, next.x, next.z].every(Number.isFinite)) {
            throw new TypeError('Edging requires finite X/Z coordinates');
        }
        const ax = cur.x - prev.x, az = cur.z - prev.z, bx = next.x - cur.x, bz = next.z - cur.z;
        const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
        const nax = -az / al, naz = ax / al;
        let nx = nax - bz / bl, nz = naz + bx / bl;
        const length = Math.hypot(nx, nz);
        if (length < 1e-6) { nx = nax; nz = naz; } else { nx /= length; nz /= length; }
        const half = width / 2 / Math.max(0.5, nx * nax + nz * naz);
        return [{ x: cur.x - nx * half, z: cur.z - nz * half },
            { x: cur.x + nx * half, z: cur.z + nz * half }];
    };
    for (const ring of rings) {
        let n = ring.length;
        if (n > 1 && ring[0].x === ring[n - 1].x && ring[0].z === ring[n - 1].z) n--;
        if (n < 3) continue;
        const first = sidePoints(ring, 0, n);
        let left = first;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n, right = j ? sidePoints(ring, j, n) : first;
            if (Math.hypot(ring[j].x - ring[i].x, ring[j].z - ring[i].z) > 1e-8) {
                polygons.push([[left[0], left[1], right[1], right[0]]]);
            }
            left = right;
            if (polygons.length >= segmentsPerStep) { yield polygons; polygons = []; }
        }
    }
    if (polygons.length) yield polygons;
}
