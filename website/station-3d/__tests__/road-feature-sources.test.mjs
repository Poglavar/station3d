import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { createRoadFeatureSourceIndex } from '../core/road-feature-sources.js';

const feature = (id, offset = 0, extra = {}) => ({
    properties: { osm_id: id, ...extra },
    geometry: { type: 'Polygon', coordinates: [[[offset, 0], [offset + 2, 0], [offset + 2, 2], [offset, 0]]] },
});
const setup = () => {
    const identities = createRoadFeatureIdentityIndex();
    return { identities, sources: createRoadFeatureSourceIndex(identities) };
};
const fullVariants = JSON.parse(fs.readFileSync(new URL('fixtures/ground-road-full-variants.json', import.meta.url)));

test('retained Koranska and Držićeva records have equal full centreline axes but distinct polygons', () => {
    for (const id of [1181711327, 141611527]) {
        const rows = fullVariants.records.filter(row => row.props.osm_id === id);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0].props.centerline_geometry, rows[1].props.centerline_geometry);
        assert.notDeepEqual(rows[0].geometry, rows[1].geometry);
        assert.ok(rows.every(row => row.urls.length > 0));
    }
});

test('both arrival orders choose the same canonical revision for both real full-way variants', () => {
    for (const id of [1181711327, 141611527]) {
        const rows = fullVariants.records.filter(row => row.props.osm_id === id);
        const selectedRevisions = [];
        for (const reversed of [false, true]) {
            const { sources } = setup();
            const byTile = {
                west: sources.prepare({ properties: rows[0].props, geometry: rows[0].geometry }, { tileKey: 'west' }),
                east: sources.prepare({ properties: rows[1].props, geometry: rows[1].geometry }, { tileKey: 'east' }),
            };
            const delivery = reversed ? [byTile.east, byTile.west] : [byTile.west, byTile.east];
            for (const record of delivery) sources.setTile(record.tileKey, [record]);
            const selected = sources.selected(delivery[0].identity.key);
            assert.ok(selected);
            selectedRevisions.push(selected.identity.revisionKey);
            assert.equal(sources.debugState().owners, 1);
            const evict = reversed ? 'west' : 'east';
            const remaining = evict === 'west' ? byTile.east : byTile.west;
            sources.removeTile(evict);
            assert.equal(sources.selected(selected.identity.key).identity.revisionKey, remaining.identity.revisionKey);
            sources.removeTile(evict === 'west' ? 'east' : 'west');
            assert.equal(sources.selected(selected.identity.key), null);
        }
        assert.equal(selectedRevisions[0], selectedRevisions[1]);
    }
});

test('same-tile replacement invalidates old revision and reports conflicting provenance', () => {
    const { identities, sources } = setup();
    const oldRecord = sources.prepare(feature(142207944, 0, { source: 'import-a' }), { tileKey: 'tile' });
    const replacement = sources.prepare(feature(142207944, 1, { source: 'import-b' }), { tileKey: 'tile' });
    sources.setTile('tile', [oldRecord]);
    assert.equal(sources.isCurrent(oldRecord.identity), true);
    assert.ok(identities.describeConflicts([oldRecord.identity, replacement.identity]).length > 0);
    sources.setTile('tile', [replacement]);
    assert.equal(sources.isCurrent(oldRecord.identity), false);
    assert.equal(sources.isCurrent(replacement.identity), true);
    assert.equal(sources.selected(replacement.identity.key).identity.revisionKey, replacement.identity.revisionKey);
});

test('explicit parts remain disjoint and hash collisions reject without mutating membership', () => {
    const { identities, sources } = setup();
    const p0 = sources.prepare(feature(-7, 0, { part_index: 0 }), { tileKey: 'a' });
    const p1 = sources.prepare(feature(-7, 1, { part_index: 1 }), { tileKey: 'a' });
    sources.setTile('a', [p0, p1]);
    assert.notEqual(p0.identity.key, p1.identity.key);
    assert.equal(sources.debugState().owners, 2);

    const collisionIds = createRoadFeatureIdentityIndex({ hashText: () => 'x' });
    const collisionSources = createRoadFeatureSourceIndex(collisionIds);
    const first = collisionSources.prepare(feature(-9), { tileKey: 'a' });
    const second = collisionSources.prepare(feature(-9, 1), { tileKey: 'b' });
    collisionSources.setTile('a', [first]);
    assert.throws(() => collisionSources.setTile('b', [second]), /collision/);
    assert.equal(collisionSources.debugState().tiles, 1);
    assert.equal(collisionSources.isCurrent(first.identity), true);
});

test('owner captures tolerate exact repeats but track membership, revisions, and ABA', () => {
    const { sources } = setup();
    const record = sources.prepare(feature(77), { tileKey: 'a' });
    sources.setTile('a', [record]);
    const capture = sources.captureOwner(record.identity.key);
    assert.deepEqual(capture.tileKeys, ['a']);
    sources.setTile('a', [sources.prepare(feature(77), { tileKey: 'a' })]);
    assert.equal(capture.isCurrent(), true);

    const duplicate = sources.prepare(feature(77), { tileKey: 'b' });
    sources.setTile('b', [duplicate]);
    assert.equal(capture.isCurrent(), false);
    const withDuplicate = sources.captureOwner(record.identity.key);
    sources.removeTile('b');
    assert.equal(withDuplicate.isCurrent(), false);

    const absent = sources.captureOwner(record.identity.key);
    sources.removeTile('a');
    const later = sources.prepare(feature(77), { tileKey: 'a' });
    sources.setTile('a', [later]);
    assert.equal(absent.isCurrent(), false);
    sources.removeTile('a');
    assert.equal(absent.isCurrent(), false);

    sources.removeTile('a');
    const absentAgain = sources.captureOwner(record.identity.key);
    sources.setTile('a', [record]);
    assert.equal(absentAgain.isCurrent(), false);
});

test('clear invalidates populated and absent captures across reload', () => {
    const { sources } = setup();
    const record = sources.prepare(feature(101), { tileKey: 'a' });
    sources.setTile('a', [record]);
    const populated = sources.captureOwner(record.identity.key);
    sources.clear();
    const absent = sources.captureOwner(record.identity.key);
    sources.setTile('a', [record]);
    assert.equal(populated.isCurrent(), false);
    assert.equal(absent.isCurrent(), false);
});

test('owner capture invalidates when selected source revision changes', () => {
    const { sources } = setup();
    const oldRecord = sources.prepare(feature(91, 0, { source: 'old' }), { tileKey: 'a' });
    const newRecord = sources.prepare(feature(91, 1, { source: 'new' }), { tileKey: 'a' });
    sources.setTile('a', [oldRecord]);
    const capture = sources.captureOwner(oldRecord.identity.key);
    sources.setTile('a', [newRecord]);
    assert.equal(capture.isCurrent(), false);
});
