// Release-wide entity consistency without retaining decoded geometry for the whole world.
// Callers supply a cryptographic digest and keep only IDs/fingerprints between tiles.
export function createWorldConsistencyAudit(digest) {
    const layers = new Map(), entities = new Map(), tiles = new Set();
    let copies = 0;
    const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
    return {
        add(tile) {
            const key = `${tile.layer}/${tile.lod}/${tile.tile.z}/${tile.tile.x}/${tile.tile.y}`;
            if (tiles.has(key)) throw new Error(`Duplicate release tile ${key}`);
            tiles.add(key);
            const layer = `${tile.layer}/${tile.lod}`;
            const profile = canonical({ sourceRevision: tile.sourceRevision, bakeVersion: tile.bakeVersion,
                compilerId: tile.packet.compilerId, compilerVersion: tile.packet.compilerVersion });
            if (layers.has(layer) && layers.get(layer) !== profile) throw new Error(`Mixed source/compiler snapshot for ${layer}`);
            layers.set(layer, profile);
            for (const entity of tile.entities) {
                const id = `${layer}/${entity.entityId}`;
                const fingerprint = digest(canonical({ entityId: entity.entityId, objectId: entity.objectId,
                    parentId: entity.parentId, sourceContract: entity.sourceContract,
                    feature: entity.feature, drawable: entity.drawable }));
                const prior = entities.get(id);
                if (prior && prior.fingerprint !== fingerprint) throw new Error(`Conflicting canonical entity ${entity.entityId}: ${prior.tile} vs ${key}`);
                if (prior) copies++;
                else entities.set(id, { fingerprint, tile: key });
            }
        },
        report: () => ({ contract: 'station3d-world-consistency-v1', ok: true,
            tiles: tiles.size, uniqueEntities: entities.size, duplicateCopies: copies, sourceSnapshots: layers.size }),
    };
}
