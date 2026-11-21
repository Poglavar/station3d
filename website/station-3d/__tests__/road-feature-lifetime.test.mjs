// Exercise the actual road lease operations used by streamed publication/eviction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { releaseRoadTileReferences, holdRoadFeatureForBuild, releaseRoadFeatureBuildHold,
    retireRoadFeatureIfUnused } from '../core/road-feature-lifetime.js';
const polygon = (id, offset = 0, part_index = null) => ({ properties: { osm_id: id, ...(part_index == null ? {} : { part_index }) }, geometry: { type: 'Polygon', coordinates: [
    [[offset, 0], [offset + 1, 0], [offset, 1], [offset, 0]],
] } });
function fixture() {
    const identities = createRoadFeatureIdentityIndex();
    const entries = new Map(), tiles = new Map(), retired = [];
    const context = { entries, tiles, retire: entry => retired.push(entry.identity.key) };
    const publish = (tile, feature) => {
        const identity = identities.identityFor(feature, { tileKey: tile });
        let entry = entries.get(identity.key);
        if (entry) identities.assertCompatible(entry.identity, identity);
        else { entry = { identity, tileRefs: new Set(), pendingRefs: 0 }; entries.set(identity.key, entry); }
        entry.tileRefs.add(tile); tiles.set(tile, new Set([identity.key]));
        return entry;
    };
    return { ...context, identities, retired, publish, release: tile => releaseRoadTileReferences(tile, context) };
}
for (const id of [123, -1679868001]) for (const order of [['a', 'b'], ['b', 'a']]) {
    test(`${id}: arrival ${order.join('/')} and eviction of either tile retains one owner`, () => {
        for (const evictFirst of order) {
            const world = fixture();
            const entry = world.publish(order[0], polygon(id)); world.publish(order[1], polygon(String(id)));
            assert.equal(world.entries.size, 1); assert.equal(entry.tileRefs.size, 2);
            world.release(evictFirst);
            assert.equal(world.entries.size, 1); assert.equal(world.retired.length, 0);
            world.release(order.find(tile => tile !== evictFirst));
            assert.equal(world.entries.size, 0); assert.equal(world.retired.length, 1);
            world.publish('reloaded', polygon(id)); assert.equal(world.entries.size, 1);
        }
    });
}
test('an in-flight retained owner survives final tile eviction until cancellation settles its hold', () => {
    const world = fixture(); const entry = world.publish('a', polygon(-7));
    holdRoadFeatureForBuild(entry); world.release('a');
    assert.equal(world.entries.size, 1);
    releaseRoadFeatureBuildHold(entry);
    assert.equal(retireRoadFeatureIfUnused(entry.identity.key, entry, world), true);
    assert.equal(world.entries.size, 0); assert.equal(world.retired.length, 1);
    assert.throws(() => releaseRoadFeatureBuildHold(entry), /twice/);
});
test('distinct clipped parts survive; a changed tile contribution releases its old content', () => {
    const world = fixture();
    const first = world.publish('a', polygon(-7, 0, 0));
    const second = world.publish('b', polygon(-7, 1, 1));
    assert.equal(world.entries.size, 2);
    assert.notEqual(first.identity.key, second.identity.key);
    world.release('a'); world.publish('a', polygon(-7, 2));
    assert.equal(world.entries.size, 2);
    assert.equal(world.entries.has(first.identity.key), false);
    assert.equal(world.entries.has(second.identity.key), true);
});
test('a stale retirement cannot delete a replacement record under the same key', () => {
    const world = fixture(); const previous = world.publish('a', polygon(-7));
    previous.tileRefs.clear(); const next = { ...previous, tileRefs: new Set(['b']) };
    world.entries.set(previous.identity.key, next);
    assert.equal(retireRoadFeatureIfUnused(previous.identity.key, previous, world), false);
    assert.equal(world.entries.get(previous.identity.key), next);
});
