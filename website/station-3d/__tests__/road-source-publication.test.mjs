// Execute the production publication boundary over real source and batch
// registries. Only mesh construction/disposal is replaced with simple parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { createRoadFeatureSourceIndex } from '../core/road-feature-sources.js';
import { holdRoadFeatureForBuild, releaseRoadFeatureBuildHold, releaseRoadTileReferences,
    retireRoadFeatureIfUnused } from '../core/road-feature-lifetime.js';

const source = fs.readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const boundary = source.slice(source.indexOf('function cleanupStagedTileBuild('),
    source.indexOf('function enqueueTileRoads('));
const feature = height => ({ properties: { osm_id: -7, height }, geometry: { type: 'Polygon',
    coordinates: [[[0, 0], [0, 2], [2, 0], [0, 0]]] } });
const part = height => ({ attributes: { position: new Float32Array([0, height, 0, 0, height, 2, 2, height, 0]) } });

function fixture() {
    const identities = createRoadFeatureIdentityIndex();
    const sources = createRoadFeatureSourceIndex(identities);
    const old = identities.identityFor(feature(0));
    const desired = sources.prepare(feature(1), { tileKey: 'a' });
    sources.setTile('a', [desired]);
    const batcher = createGeometryBatcher();
    batcher.addPart('original-region', old.key, part(0));
    const entries = new Map([[old.key, { featureKey: old.key, identity: old,
        regionTileKey: 'original-region', surfaceBucketKeys: new Set(['original-region']),
        tileRefs: new Set(['a', 'b']), pendingRefs: 0 }]]);
    const tiles = new Map([['a', new Set([old.key])], ['b', new Set([old.key])]]);
    const events = [];
    const retire = entry => {
        events.push(['retire', entry.identity.revisionKey]);
        batcher.removeOwnerEverywhere(entry.featureKey);
    };
    const context = vm.createContext({
        roadsGroup: {}, tileFeatures: new Map([['a', []], ['b', []]]),
        roadReceiverMutationEpoch: 0,
        roadEntries: entries, tileRoads: tiles, roadFeatureSources: sources,
        roadFeatureIdentities: identities, releaseRoadFeatureBuildHold,
        terrainReference: { revision: 0 },
        roadFeatureFormationGeneration: feature => feature.properties.formationGeneration || 0,
        roadSurfaceBucketsPendingPublication: new Set(['original-region']),
        roadSurfaceTiles: { awaitBuckets: tile => events.push(['ready', tile]) },
        releaseTileRoadReferences: tile => releaseRoadTileReferences(tile, { entries, tiles, retire }),
        disposeRoadEntryIfUnused: (key, entry) => retireRoadFeatureIfUnused(key, entry, { entries, retire }),
        disposePublishedRoadEntry: retire,
        disposeRoadFeatureGroup: group => events.push(['discard', group.height]),
        publishRoadFeatureGroup: (group, key, region) => {
            events.push(['stage', region, group.height]);
            batcher.addPart(region, key, part(group.height));
            return { featureKey: key, regionTileKey: region, surfaceBucketKeys: new Set([region]) };
        },
    });
    vm.runInContext(boundary, context);
    const build = tileKey => {
        holdRoadFeatureForBuild(entries.get(old.key));
        return { tileKey, heldFeatureKeys: new Set([old.key]), retainedFeatureKeys: new Set(),
            identities: new Map([[old.key, desired.identity]]), stagedGroups: new Map([[old.key, { height: 1 }]]),
            sources: new Map([[old.key, desired]]),
            groundInputs: new Map([[old.key, { formationGeneration: 0, terrainRevision: 0 }]]),
            replacementFeatureKeys: new Set(), featureTasks: new Map() };
    };
    return { context, build, entries, tiles, batcher, events, old, desired, sources };
}

test('replacement holds the old regional owner through tile release, with one final batch owner', () => {
    for (const order of [['a', 'b'], ['b', 'a']]) {
        const world = fixture();
        const first = world.build(order[0]), second = world.build(order[1]);
        assert.equal(world.context.publishStagedTileBuild(first), true);
        assert.equal(world.entries.get(world.old.key).pendingRefs, 1, 'other build lease survives replacement');
        assert.equal(world.context.publishStagedTileBuild(second), true);
        assert.equal(world.entries.get(world.old.key).pendingRefs, 0);
        assert.deepEqual([...world.entries.get(world.old.key).tileRefs].sort(), ['a', 'b']);
        const assembled = world.batcher.assemble('original-region');
        assert.equal(assembled.ranges.length, 1);
        assert.equal(assembled.vertexCount, 3, 'no simultaneous old/new polygon');
        assert.equal(assembled.attributes.position[1], 1);
        assert.deepEqual(world.events.filter(event => ['retire', 'stage', 'discard'].includes(event[0])).map(event => event[0]),
            ['retire', 'stage', 'discard']);
    }
});

test('a superseded source cannot publish or release the still-visible tile before retry', () => {
    const world = fixture();
    const build = world.build('a');
    const next = world.sources.prepare(feature(2), { tileKey: 'a' });
    world.sources.setTile('a', [next]);
    assert.equal(world.context.publishStagedTileBuild(build), false);
    assert.equal(world.entries.get(world.old.key).identity, world.old);
    assert.equal(world.entries.get(world.old.key).tileRefs.size, 2);
    assert.equal(world.events.length, 0);
    world.context.cleanupStagedTileBuild(build);
    assert.equal(world.entries.get(world.old.key).pendingRefs, 0);
    assert.equal(world.batcher.assemble('original-region').attributes.position[1], 0);
});

test('cancellation releases both partially constructed geometry and pending owner leases', () => {
    const world = fixture();
    const build = world.build('a');
    let disposed = 0;
    build.featureTasks.set(world.old.key, { dispose() { disposed++; } });
    world.context.cleanupStagedTileBuild(build);
    assert.equal(disposed, 1);
    assert.equal(build.featureTasks.size, 0);
    assert.equal(build.stagedGroups.size, 0);
    assert.equal(world.entries.get(world.old.key).pendingRefs, 0);
    assert.equal(world.entries.get(world.old.key).tileRefs.size, 2);
});

test('a newer completed formation rejects the old mesh while retaining its published owner and leases', () => {
    const world = fixture();
    const build = world.build('a');
    world.context.roadFeatureFormationGeneration = () => 2;
    assert.equal(world.context.publishStagedTileBuild(build), false);
    assert.equal(world.entries.get(world.old.key).identity, world.old);
    assert.equal(world.entries.get(world.old.key).pendingRefs, 1);
    assert.equal(world.events.length, 0);
    world.context.cleanupStagedTileBuild(build);
    assert.equal(world.entries.get(world.old.key).pendingRefs, 0);
});

test('a terrain update rejects partially completed road geometry before any owner release', () => {
    const world = fixture();
    const build = world.build('a');
    world.context.terrainReference.revision = 1;
    assert.equal(world.context.publishStagedTileBuild(build), false);
    assert.equal(world.events.length, 0);
    world.context.cleanupStagedTileBuild(build);
});

test('a stale masked-out decision cannot retire the still-visible owner', () => {
    const world = fixture();
    const build = world.build('a');
    build.stagedGroups.clear();
    build.groundInputs.get(world.old.key).isCurrent = () => false;
    assert.equal(world.context.publishStagedTileBuild(build), false);
    assert.equal(world.entries.get(world.old.key).identity, world.old);
    assert.equal(world.events.length, 0);
    world.context.cleanupStagedTileBuild(build);
    assert.equal(world.entries.get(world.old.key).pendingRefs, 0);
});

test('a source-identical neighbour update replaces the old formation mesh in the same regional owner', () => {
    const world = fixture();
    world.entries.get(world.old.key).identity = world.desired.identity;
    world.entries.get(world.old.key).formationGeneration = 1;
    const build = world.build('a');
    build.groundInputs.get(world.old.key).formationGeneration = 2;
    world.context.roadFeatureFormationGeneration = () => 2;
    assert.equal(world.context.publishStagedTileBuild(build), true);
    assert.equal(world.entries.get(world.old.key).formationGeneration, 2);
    const result = world.batcher.assemble('original-region');
    assert.equal(result.ranges.length, 1);
    assert.equal(result.attributes.position[1], 1);
});
