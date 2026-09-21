// Lightweight 2D geometry published by the existing road and water streams.
// Tile ownership deduplicates overlapping responses; the HUD reads this cache
// without fetching data or traversing the rendered world.
export function createNavigationMapContext() {
    const tiles = new Map(), roads = new Map();
    let revision = 0, water = null;
    function setRoadTile(tileKey, segments = []) {
        const next = new Map();
        for (const row of segments) {
            if (!row || row.retired || ![row.x0, row.z0, row.x1, row.z1].every(Number.isFinite)) continue;
            const key = [row.x0, row.z0, row.x1, row.z1].join(':');
            next.set(key, row);
        }
        const previous = tiles.get(tileKey) || new Set();
        let changed = false;
        for (const key of previous) {
            if (next.has(key)) continue;
            const record = roads.get(key);
            if (record && --record.owners === 0) { roads.delete(key); changed = true; }
        }
        for (const [key, row] of next) {
            if (previous.has(key)) continue;
            const record = roads.get(key);
            if (record) record.owners += 1;
            else {
                roads.set(key, { owners: 1, x0: row.x0, z0: row.z0, x1: row.x1, z1: row.z1 });
                changed = true;
            }
        }
        if (next.size) tiles.set(tileKey, new Set(next.keys()));
        else tiles.delete(tileKey);
        if (changed) revision += 1;
        return changed;
    }
    return {
        setRoadTile,
        removeRoadTile: key => setRoadTile(key),
        resetRoads() {
            tiles.clear();
            if (roads.size) { roads.clear(); revision += 1; }
        },
        setWater(next) {
            if (water === next) return false;
            water = next; revision += 1; return true;
        },
        // Read-only by convention, as with the engine's other geometry registries.
        snapshot: () => ({ revision, roads, water }),
    };
}
export const navigationMapContext = createNavigationMapContext();
