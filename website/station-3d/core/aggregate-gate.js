// Holds a tile's "detailed coverage is up" announcement until the merged
// geometry that covers it actually exists.
//
// THE PROBLEM. A finished tile hands its buildings to the geometry batcher,
// which removes the individual meshes immediately and rebuilds them as one
// merged mesh per bucket. Between those two moments the tile's walls and roofs
// exist nowhere, and the only thing covering the ground is the far layer's LOD1
// prisms — which are dropped by setDetailedTile(tileKey, true).
//
// So the two had to happen in that order, and the way that was guaranteed was
// to assemble SYNCHRONOUSLY at tile completion, unbudgeted. That hands three.js
// every freshly merged buffer at once and they all upload inside the next
// render: measured on a Zagreb walk, stall went 1.95 ms -> 4.37 ms once survey
// meshes joined the buckets, cancelling out a 27% draw-call win.
//
// THE FIX. Assembly gets budgeted like every other rebuild, and the ANNOUNCEMENT
// waits instead: a tile registers the buckets it needs, each bucket reports in
// as it is assembled, and the tile is announced only when its last one lands.
// The prisms stay up throughout, so the window is covered rather than raced.
//
// Pure bookkeeping — no THREE, no DOM — so the ordering is unit-testable.
export function createAggregateGate() {
    // tileKey -> { waiting: Set<bucketKey>, announce: () => void }
    const gated = new Map();

    return {
        // Announce immediately when there is nothing to wait for: a tile whose
        // buildings were all unmergeable (or which had none) has no merged
        // geometry pending, and holding its prisms up would be a visible lag.
        await(tileKey, bucketKeys, announce) {
            if (typeof announce !== 'function') return false;
            const waiting = new Set(bucketKeys || []);
            if (waiting.size === 0) {
                announce();
                return false;
            }
            // A tile completing twice supersedes its earlier wait rather than
            // announcing twice.
            gated.set(tileKey, { waiting, announce });
            return true;
        },

        // One bucket finished assembling. Announces every tile that was only
        // waiting on it.
        noteAssembled(bucketKey) {
            if (gated.size === 0) return;
            const ready = [];
            for (const [tileKey, entry] of gated) {
                if (!entry.waiting.delete(bucketKey)) continue;
                if (entry.waiting.size === 0) ready.push(tileKey);
            }
            for (const tileKey of ready) {
                const entry = gated.get(tileKey);
                gated.delete(tileKey);
                entry.announce();
            }
        },

        // The tile was evicted before its geometry landed: it must NOT be
        // announced afterwards, or the far layer drops prisms over ground that
        // no longer has a detailed tile at all.
        forget(tileKey) {
            gated.delete(tileKey);
        },

        // Failsafe: nothing is queued for assembly any more, so anything still
        // waiting is waiting on a bucket that will never report — announce it
        // rather than leave the tile permanently covered by prisms. A dropped
        // bucket (assembled to nothing and deleted) is the ordinary way this
        // happens.
        releaseStranded() {
            if (gated.size === 0) return 0;
            const entries = [...gated.values()];
            gated.clear();
            for (const entry of entries) entry.announce();
            return entries.length;
        },

        clear() {
            gated.clear();
        },

        get size() {
            return gated.size;
        },
    };
}
