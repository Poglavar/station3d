// Source changes flow toward dependent receivers. Curbs do not own road/rail
// formations or terrain openings, so their source tiles cannot dirty those
// upstream receivers. They still join the same ground publication boundary.
export function groundGenerationScope(changes, terrainTileM) {
    const full = changes.some(change => change.full
        && change.family !== 'bootstrap' && change.family !== 'curbs');
    const curbFull = changes.some(change => change.family === 'curbs' && change.full);
    const terrainChanges = changes.filter(change => change.family === 'terrain');
    const terrainBounds = terrainChanges.some(change => change.full)
        ? null : terrainChanges.flatMap(change => change.bounds);
    // Source ownership is checked by identity at receiver admission. A road
    // tile arriving does not change the height of every existing road in it.
    // Explicit physical changes still invalidate intersecting receivers;
    // formation and opening changes extend this set after their preparation.
    const roadGeometryBounds = changes.filter(change => !['curbs', 'terrain-window', 'ground-window'].includes(change.family))
        .flatMap(change => change.bounds);
    const receiverBounds = [], curbBounds = [], curbSourceKeys = new Set();
    for (const change of changes) {
        (change.family === 'curbs' ? curbBounds : receiverBounds).push(...change.bounds);
        if (change.family === 'terrain-window') continue;
        for (const key of change.keys) {
            const [x, z] = key.split('_').map(Number);
            if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) continue;
            if (change.family === 'curbs') { curbSourceKeys.add(key); continue; }
            const tileM = change.family === 'terrain' ? terrainTileM : 200;
            const bounds = { minX: x * tileM - 32, minZ: z * tileM - 32,
                maxX: (x + 1) * tileM + 32, maxZ: (z + 1) * tileM + 32 };
            receiverBounds.push(bounds);
            if (change.family === 'terrain' && !change.bounds.length) {
                roadGeometryBounds.push(bounds);
                terrainBounds?.push(bounds);
            }
        }
    }
    return { full, curbFull, terrainBounds, roadGeometryBounds, receiverBounds, curbBounds,
        curbSourceKeys: [...curbSourceKeys] };
}
