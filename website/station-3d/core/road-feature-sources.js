// One desired polygon revision per source owner across the currently loaded
// tile responses. The API has no authoritative revision/quality field. A stable
// lexical revision order breaks ambiguous ties; it does NOT infer newest/best
// from arrival time, polygon size or number of vertices. Conflicts stay visible.
// Rendering and support keep their previous complete owner until its successor
// is built. This index contains source intent only, not published geometry.
export function createRoadFeatureSourceIndex(identities) {
    const tiles = new Map();
    const owners = new Map();
    // Captures use the live owner's generation.  The global epoch is only
    // needed for captures of an absent owner, where there is no tombstone to
    // retain across a remove/re-add (ABA) cycle.
    let sourceEpoch = 0;

    function choose(owner) {
        let selected = null;
        for (const records of owner.tiles.values()) for (const record of records) {
            if (selected) identities.assertCompatible(selected.identity, record.identity);
            if (!selected || record.identity.revisionKey < selected.identity.revisionKey
                || (record.identity.revisionKey === selected.identity.revisionKey
                    && record.tileKey < selected.tileKey)) selected = record;
        }
        return selected;
    }

    function setTile(tileKey, records) {
        const previous = tiles.get(tileKey) || new Map();
        const next = new Map();
        for (const record of records) {
            if (record.tileKey !== tileKey) throw new Error('Road source record belongs to another tile');
            const key = record.identity.key;
            let contributions = next.get(key);
            if (!contributions) next.set(key, contributions = []);
            // Exact repeats in one response need neither memory nor references.
            const sameRevision = contributions.find(item => item.identity.revisionKey === record.identity.revisionKey);
            if (sameRevision) identities.assertCompatible(sameRevision.identity, record.identity);
            else contributions.push(record);
        }
        // Validate collisions BEFORE mutating active source membership.
        for (const [key, incoming] of next) {
            const owner = owners.get(key);
            for (const record of incoming) for (const existing of owner?.tiles.values() || []) {
                for (const item of existing) identities.assertCompatible(item.identity, record.identity);
            }
        }
        const changed = [];
        for (const key of new Set([...previous.keys(), ...next.keys()])) {
            let owner = owners.get(key);
            if (!owner) owners.set(key, owner = { tiles: new Map(), selected: null, generation: 0 });
            const old = owner.selected;
            const hadTile = owner.tiles.has(tileKey);
            if (next.has(key)) owner.tiles.set(tileKey, next.get(key));
            else owner.tiles.delete(tileKey);
            owner.selected = choose(owner);
            const membershipChanged = hadTile !== owner.tiles.has(tileKey);
            const selectedChanged = old?.identity.canonical !== owner.selected?.identity.canonical;
            if (membershipChanged || selectedChanged) {
                owner.generation += 1;
                sourceEpoch += 1;
            }
            if (selectedChanged) {
                changed.push({ key, previous: old, next: owner.selected });
            }
            if (!owner.selected) owners.delete(key);
        }
        if (next.size) tiles.set(tileKey, next);
        else tiles.delete(tileKey);
        return changed;
    }

    return {
        prepare(feature, { tileKey, featureIndex = 0 }) {
            return { feature, tileKey, featureIndex,
                identity: identities.identityFor(feature, { tileKey, featureIndex }) };
        },
        setTile,
        removeTile(tileKey) { return setTile(tileKey, []); },
        selected(key) { return owners.get(key)?.selected || null; },
        keys: () => owners.keys(),
        get revision() { return sourceEpoch; },
        captureOwner(key) {
            const owner = owners.get(key);
            if (!owner) {
                const capturedEpoch = sourceEpoch;
                return Object.freeze({ selected: null, tileKeys: Object.freeze([]),
                    isCurrent() {
                        return sourceEpoch === capturedEpoch && !owners.has(key);
                    } });
            }
            const selected = owner.selected || null;
            const capturedOwner = owner;
            const generation = owner.generation;
            const tileKeys = Object.freeze([...owner.tiles.keys()]);
            return Object.freeze({ selected, tileKeys,
                isCurrent() {
                    const current = owners.get(key);
                    return current === capturedOwner && current.generation === generation
                        && current.selected?.identity.canonical === selected?.identity.canonical
                        && current.tiles.size === tileKeys.length
                        && tileKeys.every(tileKey => current.tiles.has(tileKey));
                } });
        },
        isCurrent(identity) {
            const desired = owners.get(identity?.key)?.selected?.identity;
            return !!desired && desired.canonical === identity.canonical;
        },
        conflicts(limit = 32) {
            const result = [];
            for (const [key, owner] of owners) {
                const variants = new Set();
                for (const records of owner.tiles.values()) {
                    for (const record of records) variants.add(record.identity.revisionKey);
                }
                if (variants.size > 1) result.push({ key, reason: 'conflicting-full-source-variants',
                    selectedRevision: owner.selected.identity.revisionKey, variants: [...variants].sort() });
                if (result.length >= limit) break;
            }
            return result;
        },
        debugState() { return { tiles: tiles.size, owners: owners.size }; },
        clear() {
            if (tiles.size || owners.size) sourceEpoch += 1;
            tiles.clear(); owners.clear();
        },
    };
}
