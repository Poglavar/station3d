// Pure projection of one immutable GDI polygon face into Station3D local XYZ.
// Large source rings expose bounded stages so a caller can retain its detached
// transaction and yield without changing the resulting vertex arrays.

const DEFAULT_VERTICES_PER_STAGE = 256;

function positiveIntegerOr(value, fallback) {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function* localizeGdiFaceCooperative(
    polygonCoords,
    zMin,
    anchorLat,
    anchorLon,
    scaleLon,
    scaleLat,
    { verticesPerStage = DEFAULT_VERTICES_PER_STAGE } = {},
) {
    const ring = polygonCoords?.[0];
    if (!Array.isArray(ring)) return [];
    const closed = ring.length > 1
        && ring[0]?.[0] === ring[ring.length - 1]?.[0]
        && ring[0]?.[1] === ring[ring.length - 1]?.[1];
    const pointCount = ring.length - (closed ? 1 : 0);
    if (pointCount < 3) return [];
    const stageSize = positiveIntegerOr(verticesPerStage, DEFAULT_VERTICES_PER_STAGE);
    const localized = new Array(pointCount);
    for (let index = 0; index < pointCount; index++) {
        const point = ring[index];
        const lon = point?.[0];
        const lat = point?.[1];
        const z = point?.[2];
        localized[index] = [
            (lon - anchorLon) * scaleLon,
            (z != null ? z : zMin) - zMin,
            -(lat - anchorLat) * scaleLat,
        ];
        if ((index + 1) % stageSize === 0) {
            yield { phase: 'geometry-localize', completed: index + 1, total: pointCount };
        }
    }
    return localized;
}

export function localizeGdiFace(...args) {
    const iterator = localizeGdiFaceCooperative(...args);
    let next;
    do {
        next = iterator.next();
    } while (!next.done);
    return next.value;
}
