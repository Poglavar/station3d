// Source-neutral synthetic keys preserve polygon parts and expose conflicting content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { roadEntityMetadata } from '../core/entity-metadata.js';
const exterior = [[0,0],[4,0],[4,4],[0,4],[0,0]];
const hole = [[1,1],[2,1],[2,2],[1,1]];
const polygon = (id, rings = [exterior], extra = {}) => ({ type: 'Feature', properties: { osm_id: id, ...extra }, geometry: { type: 'Polygon', coordinates: rings } });

test('synthetic ids are dataset scoped and preserve exact decimal text without invented OSM links', () => {
    const index = createRoadFeatureIdentityIndex();
    const feature = polygon('-900719925474099312345');
    assert.equal(index.identityFor(feature).entityKey, 'croatia-road-surfaces:polygon:-900719925474099312345');
    assert.equal(index.identityFor(feature).provenance.osmType, null);
    const metadata = roadEntityMetadata(feature);
    assert.equal(metadata.osmId, null); assert.equal(metadata.osmType, null);
    assert.equal(metadata.sourceObjectId, '-900719925474099312345');
    assert.notEqual(createRoadFeatureIdentityIndex({ dataset: 'other-roads' }).identityFor(feature).key, index.identityFor(feature).key);
    assert.equal(index.identityFor(polygon(-9007199254740992)).entityKey, null);
    assert.equal(index.identityFor(polygon(9007199254740992)).entityKey, null);
    assert.equal(index.identityFor(polygon('0')).entityKey, null);
    assert.equal(index.identityFor(polygon('123', [exterior], { osm_type: 'relation' })).entityKey, 'osm:relation:123');
});

test('polygon closure, winding, start vertex, holes and multipolygon order are canonical', () => {
    const index = createRoadFeatureIdentityIndex();
    const rotated = [...exterior.slice(2, -1), ...exterior.slice(0, 2)].reverse();
    assert.equal(index.identityFor(polygon(-7)).key, index.identityFor(polygon('-7', [rotated])).key);
    const a = polygon(-8, [exterior, hole]);
    const b = polygon(-8, [rotated, [...hole].reverse()]);
    assert.equal(index.identityFor(a).key, index.identityFor(b).key);
    assert.equal(index.identityFor(a).key, index.identityFor(polygon(-8)).key);
    assert.notEqual(index.identityFor(a).revisionKey, index.identityFor(polygon(-8)).revisionKey, 'a hole changes revision');
    assert.equal(index.identityFor(a).key, index.identityFor(polygon(-8, [hole, exterior])).key);
    assert.notEqual(index.identityFor(a).revisionKey, index.identityFor(polygon(-8, [hole, exterior])).revisionKey, 'the exterior is not interchangeable with a hole');
    const multi = rings => ({ properties: { osm_id: -9 }, geometry: { type: 'MultiPolygon', coordinates: rings } });
    assert.equal(index.identityFor(multi([[exterior], [hole]])).key, index.identityFor(multi([[hole], [rotated]])).key);
});

test('changed geometry and conflicting provenance do not silently reuse an old part', () => {
    const index = createRoadFeatureIdentityIndex();
    const a = index.identityFor(polygon(-7));
    const fragment = index.identityFor(polygon(-7, [hole], { part_index: 1 }));
    const changed = index.identityFor(polygon(-7, [exterior], { source: 'different-import' }));
    assert.notEqual(a.key, fragment.key); assert.equal(a.key, changed.key);
    assert.notEqual(a.revisionKey, fragment.revisionKey); assert.notEqual(a.revisionKey, changed.revisionKey);
    assert.deepEqual(index.describeConflicts([a, fragment]), [], 'distinct clipped parts survive');
    assert.equal(index.describeConflicts([a, changed])[0].reason, 'conflicting-full-source-variants');
    assert.equal(index.describeConflicts([changed, a])[0].reason, 'conflicting-full-source-variants');
});

test('an injected fingerprint collision fails exact comparison', () => {
    const index = createRoadFeatureIdentityIndex({ hashText: () => 'collision' });
    const a = index.identityFor(polygon(-7));
    const b = index.identityFor(polygon(-7, [hole]));
    assert.equal(a.key, b.key);
    assert.throws(() => index.assertCompatible(a, b), /collision/);
    assert.equal(index.debugState().conflicts.length, 1);
});

test('cache ownership is per index and reset does not retain an archive of source features', () => {
    const index = createRoadFeatureIdentityIndex();
    const feature = polygon(-7);
    for (let i = 0; i < 100; i++) index.identityFor(feature);
    assert.equal(index.debugState().computed, 1);
    index.clear();
    assert.equal(index.debugState().computed, 0);
    index.identityFor(feature);
    assert.equal(index.debugState().computed, 1);
});
