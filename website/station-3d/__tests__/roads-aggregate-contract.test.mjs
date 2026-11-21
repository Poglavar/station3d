// Roads publish through the geometry batcher: features hand their built
// meshes' arrays to owner-keyed buckets and the scene holds one merged mesh
// per bucket. These pin the wiring the way roads-stage-contract pins the ctx
// contract — these are narrow source-wiring checks. Actual frame scheduling,
// support/picking rollback and retry are exercised with Three and the real
// registry in road-aggregate-publication.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROADS = readFileSync(
    fileURLToPath(new URL('../world/roads.js', import.meta.url)),
    'utf8',
);

test('publishing a feature feeds the batcher under its feature key', () => {
    // Both entry-creation sites must pass the feature key — an owner published
    // under undefined can never be evicted, and every removal would miss.
    // `published = …` pins the CALL sites; the bare pattern also matches the
    // function's own definition line.
    const calls = ROADS.match(/published = publishRoadFeatureGroup\((?:group|stagedGroup), featureKey, tileKey\)/g) || [];
    assert.equal(calls.length, 2, 'new owners publish in the tile that first owns them');
    assert.doesNotMatch(ROADS, /publishRoadFeatureGroup\(stagedGroup\);/,
        'replacement geometry must never accumulate under an undefined owner');
    assert.match(ROADS, /return\s*\{\s*featureKey,\s*regionTileKey,/,
        'published entries remember the regional bucket that already renders them');
    assert.match(ROADS, /roadBatcher\.addPart\(bucketKey, featureKey/,
        'publish decomposes meshes into batcher parts');
    assert.match(ROADS, /roadBatcher\.removeOwnerEverywhere\(entry\.featureKey\)/,
        'disposing an entry removes its owner from every bucket');
});

test('transactional replacement removes the old owner before publishing its successor', () => {
    const replacementStart = ROADS.indexOf('if (entry && (build.replacementFeatureKeys.has(featureKey)');
    assert.notEqual(replacementStart, -1);
    const replacement = ROADS.slice(replacementStart, replacementStart + 1400);
    assert.match(
        replacement,
        /const regionTileKey = entry\.regionTileKey \?\? tileKey;[\s\S]{0,420}disposePublishedRoadEntry\(entry\);[\s\S]{0,260}publishRoadFeatureGroup\(\s*stagedGroup,\s*featureKey,\s*regionTileKey,?\s*\)/,
        'remove-then-add preserves one owner and one already-visible regional bucket',
    );
});

// Ordering, cooperative staging, stale cancellation and atomic rollback are
// executed by road-aggregate-publication.test.mjs. Do not duplicate them here
// as regexes over local variable names or control-flow formatting.

test('road tiles expose asphalt publication to dependent curb tiles', () => {
    assert.match(ROADS, /ctx\.roadSurfaceTiles\s*=\s*roadSurfaceTiles/,
        'roads publish their per-session asphalt readiness tracker on the shared context');
    assert.match(
        ROADS,
        /roadSurfaceTiles\.awaitBuckets\(tileKey,\s*requiredSurfaceBuckets\)/,
        'a tile waits only for the aggregate buckets containing its own new asphalt');
    assert.match(ROADS, /roadSurfaceTiles\?\.markBucketReady\(bucketKey\)/,
        'aggregate assembly releases dependent tiles after the actual GPU geometry swap');
    assert.match(ROADS, /roadSurfaceTiles\.forget\(tileKey\)/,
        'evicted tile readiness cannot leak into a later reload');
    assert.match(ROADS, /tileSource\.isLoadedAtLocal\(x, z\)/);
    assert.match(ROADS, /centerlineSource\.isLoadedAtLocal\(x, z\)/);
    assert.match(ROADS, /verticalAlignmentSource\.isLoadedAtLocal\(x, z\)/);
    assert.match(ROADS, /roadSurfaceTiles\.isCurrent\(key\)/,
        'campaign readiness follows the newest vertical generation, not first paint');
});

test('aggregates are assembled on settle and forced where staleness would show', () => {
    assert.match(ROADS, /flushRoadAggregatesIfSettled\(\);/,
        'onFrame drives the settle-gated assemble');
    // The spawn tiles and the synchronous proposal rebuild cannot wait out a
    // settle window — the world would open (or repaint) over bare terrain.
    const forced = ROADS.match(/flushRoadAggregatesNow\(\);/g) || [];
    assert.ok(forced.length >= 2, `expected forced flushes at spawn + proposal rebuild, found ${forced.length}`);
});

test('assembled ranges re-register picking', () => {
    assert.match(ROADS, /registerAggregateEntityRanges\(mesh, assembled\.ranges\)/,
        'entity ranges from assembly reach the picking layer');
});
