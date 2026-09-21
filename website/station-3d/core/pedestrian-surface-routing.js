// Pure route sampling for surfaces ambient pedestrians must never enter. The
// caller supplies the world classifier so this remains renderer-independent.

function finitePoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

export function segmentCrossesForbiddenSurface(
    start,
    end,
    isForbiddenAt,
    { sampleSpacingM = 1.5 } = {},
) {
    if (!finitePoint(start) || !finitePoint(end) || typeof isForbiddenAt !== 'function') {
        return true;
    }
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const spacing = Math.max(0.25, Number(sampleSpacingM) || 1.5);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        const x = start.x + (end.x - start.x) * ratio;
        const z = start.z + (end.z - start.z) * ratio;
        if (isForbiddenAt(x, z)) return true;
    }
    return false;
}

export function routeCrossesForbiddenSurface(start, route, isForbiddenAt, options) {
    if (!finitePoint(start) || !Array.isArray(route) || route.length === 0) return true;
    let legStart = start;
    for (const waypoint of route) {
        if (segmentCrossesForbiddenSurface(legStart, waypoint, isForbiddenAt, options)) return true;
        legStart = waypoint;
    }
    return false;
}
