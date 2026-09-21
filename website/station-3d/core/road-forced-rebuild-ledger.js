// Durable per-tile record of road features that MUST rebuild instead of being
// retained from the published cache after a ground or alignment revision.
//
// A terrain/alignment revision names the OSM ids whose published geometry is
// now stale (forceRebuildOsmIds), but that set used to live only inside one
// coalesced refresh batch. Two ordinary races dropped it on the floor:
//
//   - the flush skips a tile whose centreline (roads:graph) tile has not
//     arrived yet — routine during spawn streaming — and the batch dies with
//     its force set;
//   - a later, force-less refresh for the same tile supersedes the forced
//     build before it publishes.
//
// Either way the next rebuild sees a published entry, takes the retain path,
// and re-publishes the stale mesh verbatim — permanently. The visible result
// was buffered footway/path surfaces frozen at coarse-terrain heights, floating
// ~2 m above the 1 m-detail ground at the Branimirova underpass and reading as
// a see-through slit across the rail embankment.
//
// The ledger makes the obligation durable: stash() records it, consume() folds
// it into a build's force set WITHOUT clearing, and only notePublished() — a
// build that actually published — settles the consumed ids. A skipped or
// cancelled build therefore leaves the obligation in place for the next one.
export function createForcedRebuildLedger() {
    const pendingByTile = new Map();

    return {
        // Record that these OSM ids must not be retained on the next rebuild
        // of this tile. Safe to call with ids that never appear in the tile:
        // membership is only ever tested per feature.
        stash(tileKey, osmIds) {
            if (!osmIds) return;
            const key = String(tileKey);
            let pending = pendingByTile.get(key);
            for (const osmId of osmIds) {
                if (!pending) {
                    pending = new Set();
                    pendingByTile.set(key, pending);
                }
                pending.add(String(osmId));
            }
        },

        // The force set a build should run with: the caller's own ids plus any
        // outstanding obligation for the tile. Deliberately does NOT clear the
        // ledger — the build may still be skipped or cancelled. `consumed` is
        // the snapshot to pass to notePublished() when the build publishes.
        consume(tileKey, extraOsmIds = null) {
            const pending = pendingByTile.get(String(tileKey)) || null;
            const extra = extraOsmIds || null;
            if (!pending && !extra) {
                return { forceRebuildOsmIds: null, consumed: null };
            }
            const forceRebuildOsmIds = new Set();
            for (const osmId of extra || []) forceRebuildOsmIds.add(String(osmId));
            for (const osmId of pending || []) forceRebuildOsmIds.add(String(osmId));
            return {
                forceRebuildOsmIds,
                consumed: pending ? new Set(pending) : null,
            };
        },

        // A build that included `consumed` published: those obligations are
        // met. Ids stashed after the consume() snapshot survive for the next
        // build, so a revision landing mid-build is never lost.
        notePublished(tileKey, consumed) {
            if (!consumed) return;
            const key = String(tileKey);
            const pending = pendingByTile.get(key);
            if (!pending) return;
            for (const osmId of consumed) pending.delete(osmId);
            if (pending.size === 0) pendingByTile.delete(key);
        },

        get size() {
            return pendingByTile.size;
        },

        clear() {
            pendingByTile.clear();
        },
    };
}
