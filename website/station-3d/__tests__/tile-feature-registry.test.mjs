// The registry exists to stop a tile arrival costing O(everything loaded). These
// pin both halves of that: the dedup/refcount rules, and that re-deriving is
// proportional to what changed rather than to what is loaded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileFeatureRegistry } from '../core/tile-feature-registry.js';

const byOsmId = (feature, tileKey, index) => (
    feature?.properties?.osm_id != null
        ? `osm:${feature.properties.osm_id}`
        : `tile:${tileKey}:${index}`
);

const road = (osmId) => ({ properties: { osm_id: osmId }, geometry: { type: 'Polygon' } });

test('the same feature from two tiles is one record, and survives one eviction', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [road(1), road(2)]);
    registry.setTile('b', [road(2), road(3)]);
    assert.equal(registry.size, 3, 'osm 2 arrived twice and must be held once');

    registry.removeTile('a');
    assert.deepEqual(
        registry.features().map(f => f.properties.osm_id).sort(),
        [2, 3],
        'osm 2 is still carried by tile b',
    );
    registry.removeTile('b');
    assert.equal(registry.size, 0);
});

test('revision advances only when the unique set really changes', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [road(1), road(2)]);
    const afterFirst = registry.revision;

    // An overlapping bbox delivering only roads we already hold. This is the
    // case that used to buy a full index rebuild for nothing.
    assert.equal(registry.setTile('b', [road(1), road(2)]), false);
    assert.equal(registry.revision, afterFirst, 'no new feature, no new revision');

    // Evicting one of two tiles that both carry everything changes nothing either.
    assert.equal(registry.removeTile('b'), false);
    assert.equal(registry.revision, afterFirst);

    assert.equal(registry.setTile('c', [road(9)]), true);
    assert.ok(registry.revision > afterFirst);
});

test('re-fetching a tile replaces its contribution instead of doubling it', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [road(1), road(2)]);
    registry.setTile('a', [road(2)]);                 // same tile, road 1 gone
    assert.deepEqual(registry.features().map(f => f.properties.osm_id), [2]);

    // And the refcount is not left at two, so ONE eviction empties it.
    registry.removeTile('a');
    assert.equal(registry.size, 0);
});

test('an identical parsed payload is a no-op for membership and revision', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    const original = [
        { ...road(1), geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
        road(2),
    ];
    assert.equal(registry.setTile('a', original), true);
    const revision = registry.revision;

    const parsedAgain = JSON.parse(JSON.stringify(original));
    assert.equal(registry.setTile('a', parsedAgain), false);
    assert.equal(registry.revision, revision, 'identical content must not fan out a rebuild');
    assert.equal(registry.features()[0], original[0], 'the existing representative stays memoised');
});

test('changed content under the same keys still replaces the tile', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    const original = {
        ...road(1),
        geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] },
    };
    registry.setTile('a', [original]);
    const revision = registry.revision;
    const changed = JSON.parse(JSON.stringify(original));
    changed.geometry.coordinates[1][0] = 30;

    assert.equal(registry.setTile('a', [changed]), true);
    assert.equal(registry.revision, revision + 1);
    assert.equal(registry.features()[0], changed);
});

test('empty tile delivery and redelivery never advance revision', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    assert.equal(registry.setTile('empty', []), false);
    assert.equal(registry.setTile('empty', []), false);
    assert.equal(registry.clear(), false);
    assert.equal(registry.revision, 0);
});

test('a tile that repeats one key contributes it once', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [road(1), road(1), road(1)]);
    assert.equal(registry.size, 1);
    registry.removeTile('a');
    assert.equal(registry.size, 0, 'a repeat must not strand the record');
});

test('derived values are computed once per feature, not once per rebuild', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    let derivations = 0;
    const derive = (feature) => {
        derivations += 1;
        return [{ id: feature.properties.osm_id }];
    };

    registry.setTile('a', [road(1), road(2), road(3)]);
    assert.equal(registry.collect(derive).length, 3);
    assert.equal(derivations, 3);

    // The rebuild that matters: one new tile arrives and we re-collect. Only the
    // new feature may be derived again — this is the whole point of the change.
    registry.setTile('b', [road(3), road(4)]);
    const entries = registry.collect(derive);
    assert.equal(entries.length, 4);
    assert.equal(derivations, 4, 'existing features must reuse their memo');

    // A collect with nothing changed derives nothing at all.
    registry.collect(derive);
    assert.equal(derivations, 4);
});

test('clearDerived forces re-derivation without disturbing membership', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    let derivations = 0;
    const derive = () => { derivations += 1; return [{}]; };
    registry.setTile('a', [road(1), road(2)]);
    registry.collect(derive);
    assert.equal(derivations, 2);

    registry.clearDerived();
    registry.collect(derive);
    assert.equal(derivations, 4);
    assert.equal(registry.size, 2, 'membership untouched');
});

test('clear empties everything and bumps the revision once', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [road(1)]);
    const before = registry.revision;
    assert.equal(registry.clear(), true);
    assert.equal(registry.size, 0);
    assert.equal(registry.revision, before + 1);
    assert.equal(registry.clear(), false, 'clearing an empty registry is a no-op');
    assert.equal(registry.revision, before + 1);
});

test('features without a stable key stay tile-scoped', () => {
    const registry = createTileFeatureRegistry({ featureKey: byOsmId });
    registry.setTile('a', [{ geometry: {} }]);
    registry.setTile('b', [{ geometry: {} }]);
    assert.equal(registry.size, 2, 'no shared identity, so no dedup');
    registry.removeTile('a');
    assert.equal(registry.size, 1);
});
