// Deduplicated view of a streamed tile layer, maintained INCREMENTALLY.
//
// A tile stream delivers overlapping bboxes, so the same OSM feature arrives
// from several tiles and a consumer that wants "every feature once" has to
// dedupe. Doing that by re-scanning every loaded tile on each arrival is O(all
// loaded features) per tile — which is invisible early and crippling later.
//
// Measured 2026-07-30 on a Zagreb cab ride: decor's road-surface index rebuilt
// exactly this way from a setTimeout, and grew from 258 ms to 666 ms across four
// minutes purely because more tiles had accumulated. It never showed in `hooks`
// or in `fat items` (it is not a frame-chunk queue and not a render hook), so it
// logged as `outside-loop` — a ~600 ms freeze every 10-20 s attributable to
// nothing.
//
// Here a tile arrival costs only ITS OWN features. Records are reference-counted
// by contributing tile, so a feature survives while any loaded tile still
// carries it and disappears with the last one. `revision` advances only when the
// unique key set actually changes, which is the signal a consumer should rebuild
// on — it replaces sorting and joining every key into one giant signature
// string. A replacement whose keys stay stable but whose content changes also
// advances it, so consumers never mistake an edited feature for a redelivery.
//
// Per-feature derived values (projected rings, bounds, prepared geometry) are
// memoised on the record, so a rebuild after one new tile re-derives only that
// tile's features. Derived values must not depend on anything that changes
// without a clear(); callers whose projection anchor can move should call
// clearDerived() when it does.

function defaultFeatureKey(feature, tileKey, featureIndex) {
    return `tile:${tileKey}:${featureIndex}`;
}

// Tile sources can legitimately deliver a freshly parsed copy of content we
// already hold. Reference equality cannot identify that case, while serialising
// every loaded tile into a retained signature duplicates a large amount of
// GeoJSON memory. Keep the previous payload's existing references and compare
// only the tile being replaced. GeoJSON is acyclic JSON data, so this exact
// structural comparison is both collision-free and bounded by one tile.
function tilePayloadEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right || left == null || right == null) return false;
    if (typeof left !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index++) {
            if (!tilePayloadEqual(left[index], right[index])) return false;
        }
        return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)
            || !tilePayloadEqual(left[key], right[key])) {
            return false;
        }
    }
    return true;
}

export function createTileFeatureRegistry({ featureKey = defaultFeatureKey } = {}) {
    // key -> { feature, tiles: Set<tileKey>, derived: undefined }
    const records = new Map();
    // tileKey -> key[] contributed by that tile, so removal is O(that tile)
    const tileContributions = new Map();
    // tileKey -> original Feature[]; SharedTileSession already owns these
    // payloads, so this adds references rather than a second serialised copy.
    const tilePayloads = new Map();
    let revision = 0;

    function dropTile(tileKey) {
        const keys = tileContributions.get(tileKey);
        if (!keys) return false;
        tileContributions.delete(tileKey);
        tilePayloads.delete(tileKey);
        let changed = false;
        for (const key of keys) {
            const record = records.get(key);
            if (!record) continue;
            record.tiles.delete(tileKey);
            if (record.tiles.size === 0) {
                records.delete(key);
                changed = true;
            }
        }
        return changed;
    }

    return {
        get revision() {
            return revision;
        },

        get size() {
            return records.size;
        },

        // Replaces whatever this tile contributed before, so a re-fetch of the
        // same tile key cannot double-count or strand stale features.
        setTile(tileKey, features) {
            const list = Array.isArray(features) ? features : [];
            const previousPayload = tilePayloads.get(tileKey);
            if (previousPayload && tilePayloadEqual(previousPayload, list)) return false;

            let changed = dropTile(tileKey);
            const keys = [];
            // Set, not keys.includes: a dense tile carries thousands of
            // features, and a linear membership scan per feature would put back
            // a quadratic of its own.
            const seen = new Set();
            for (let index = 0; index < list.length; index++) {
                const feature = list[index];
                const key = featureKey(feature, tileKey, index);
                // A tile repeating one key must contribute it once, or eviction
                // would need to decrement it as many times as it appeared.
                if (seen.has(key)) continue;
                seen.add(key);
                keys.push(key);
                const existing = records.get(key);
                if (existing) {
                    existing.tiles.add(tileKey);
                    continue;
                }
                records.set(key, { feature, tiles: new Set([tileKey]), derived: undefined });
                changed = true;
            }
            tileContributions.set(tileKey, keys);
            tilePayloads.set(tileKey, list);
            if (changed) revision += 1;
            return changed;
        },

        removeTile(tileKey) {
            const changed = dropTile(tileKey);
            if (changed) revision += 1;
            return changed;
        },

        clear() {
            // Empty tiles are bookkeeping only; clearing them must not publish
            // a content revision when the visible unique set was already empty.
            const changed = records.size > 0;
            records.clear();
            tileContributions.clear();
            tilePayloads.clear();
            if (changed) revision += 1;
            return changed;
        },

        // Forget memoised derived values without touching membership. For a
        // consumer whose derivation depends on session state (a projection
        // anchor, say) that changed under it.
        clearDerived() {
            for (const record of records.values()) record.derived = undefined;
        },

        // Flat array of every unique feature's derived entries. `derive` runs at
        // most once per feature per clearDerived() and must return an array.
        collect(derive) {
            const collected = [];
            for (const [key, record] of records) {
                if (record.derived === undefined) {
                    record.derived = derive(record.feature, key) || [];
                }
                for (let index = 0; index < record.derived.length; index++) {
                    collected.push(record.derived[index]);
                }
            }
            return collected;
        },

        // Unique features in insertion order, for consumers that want the
        // features themselves rather than something derived from them.
        features() {
            const list = [];
            for (const record of records.values()) list.push(record.feature);
            return list;
        },
    };
}
