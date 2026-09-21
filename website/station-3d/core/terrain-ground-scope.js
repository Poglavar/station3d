// Pending terrain jobs are requests, not published receivers or retained read
// leases. A failed generation may leave requests for an old camera window;
// never let one request both rebuild and remove the same resident tile.
export function* selectTerrainGroundScopeSteps({ residentKeys, pendingJobs, pinnedKeys,
    centerTileX, centerTileZ, keepRing, maxChangedTiles }) {
    if (!residentKeys?.[Symbol.iterator] || !Array.isArray(pendingJobs) || !(pinnedKeys instanceof Set)
        || ![centerTileX, centerTileZ, keepRing, maxChangedTiles].every(Number.isSafeInteger)
        || keepRing < 0 || maxChangedTiles < 1) throw new TypeError('Terrain scope requires a bounded tile window');
    const needed = key => {
        if (typeof key !== 'string' || !/^-?\d+_-?\d+$/.test(key)) throw new TypeError('Invalid terrain scope tile');
        const [x, z] = key.split('_').map(Number);
        if (![x, z].every(Number.isSafeInteger)) throw new TypeError('Invalid terrain scope coordinates');
        return pinnedKeys.has(key) || Math.abs(x - centerTileX) <= keepRing && Math.abs(z - centerTileZ) <= keepRing;
    };
    const desired = new Set(), removed = new Set(), pending = new Map();
    for (const key of residentKeys) {
        if (needed(key)) desired.add(key); else removed.add(key);
        yield { phase: 'terrain-dependency-closure' };
    }
    for (const job of pendingJobs) {
        if (needed(job?.key)) { desired.add(job.key); if (!pending.has(job.key)) pending.set(job.key, job); }
        yield { phase: 'terrain-dependency-closure' };
    }
    if (desired.size + removed.size > maxChangedTiles) {
        throw Object.assign(new Error('Terrain dependency closure exceeds capacity'), { code: 'ground-generation-capacity' });
    }
    return { tileKeys: [...desired], removeKeys: [...removed], pendingJobs: [...pending.values()] };
}
