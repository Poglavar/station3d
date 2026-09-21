// Read-only audit coverage. Visit every intersecting source tile, including
// missing tiles; unrelated prefetch work must not hold a local audit open.
export function auditTilePoints(bounds, tileM = 200) {
    if (!bounds || !['minX', 'maxX', 'minZ', 'maxZ'].every(key => Number.isFinite(bounds[key]))
        || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ || !(tileM > 0)) {
        throw new TypeError('Invalid audit bounds');
    }
    const points = [];
    for (let z = Math.floor(bounds.minZ / tileM); z < Math.ceil(bounds.maxZ / tileM); z++) {
        for (let x = Math.floor(bounds.minX / tileM); x < Math.ceil(bounds.maxX / tileM); x++) {
            points.push({ key: `${x}_${z}`,
                x: (Math.max(bounds.minX, x * tileM) + Math.min(bounds.maxX, (x + 1) * tileM)) / 2,
                z: (Math.max(bounds.minZ, z * tileM) + Math.min(bounds.maxZ, (z + 1) * tileM)) / 2 });
        }
    }
    return points;
}

export function auditSourceCoverage(source, bounds) {
    const tiles = auditTilePoints(bounds, source.tileM).map(point => ({
        key: point.key, status: source.tiles.get(point.key)?.status || 'missing',
        failed: source.failed.has(point.key),
    }));
    return { tiles, pending: tiles.filter(tile => tile.status !== 'loaded').length,
        failed: tiles.filter(tile => tile.failed).length };
}
