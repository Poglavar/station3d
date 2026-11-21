import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { planRegionalTileRebuild } from '../core/regional-tile-rebuild.js';

const buildingsSource = await readFile(new URL('../world/buildings.js', import.meta.url), 'utf8');
const railsSource = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
const sourceEntitiesSource = await readFile(new URL('../world/source-entities.js', import.meta.url), 'utf8');
const staticModeSource = await readFile(new URL('../modes/static.js', import.meta.url), 'utf8');
const waterSource = await readFile(new URL('../world/water.js', import.meta.url), 'utf8');

test('regional building replay selects only stale payloads nearest-first', () => {
    const current = { architectureId: 'split' };
    const near = { architectureId: 'zagreb' };
    const far = { architectureId: 'zagreb' };
    const tiles = new Map([
        ['8_0', far],
        ['0_0', near],
        ['1_0', current],
    ]);

    const plan = planRegionalTileRebuild(tiles, 'split', {
        tileM: 100,
        focusX: 40,
        focusZ: 40,
    });

    assert.deepEqual(plan.map(task => task.tileKey), ['0_0', '8_0']);
    assert.equal(plan[0].payload, near);
    assert.equal(plan[0].architectureId, 'split');
});

test('regional building replay does not mutate cached tile ownership', () => {
    const payload = { architectureId: 'zagreb', features: [1, 2] };
    const tiles = new Map([['0_0', payload]]);
    planRegionalTileRebuild(tiles, 'split', { tileM: 100 });

    assert.equal(payload.architectureId, 'zagreb');
    assert.equal(tiles.get('0_0'), payload);
});

test('building presentation reads the live region and replays cached tiles', () => {
    assert.doesNotMatch(buildingsSource, /ACTIVE_LOCATION/);
    assert.match(buildingsSource, /buildingTileSourceForLocation\(location\)/);
    // Real style/descriptor functions are exercised across a live city change
    // in retired-active-location-binding.test.mjs, including deferred sources.
    assert.match(buildingsSource, /const style = activePitchedRoofStyle\(\)/);
    assert.match(buildingsSource, /queueRegionalBuildingRebuild\(architectureId\)/);
    assert.match(buildingsSource, /drainRegionalBuildingRebuild\(\)/);
});

test('all coordinate-opened modes establish spatial location before loading buildings', () => {
    assert.match(staticModeSource, /applyAnchorStyle\(lat, lon\)/);
});

test('mapped water is spatial and never gated by a location flag', () => {
    assert.doesNotMatch(waterSource, /getLocation\(\)\.water/);
    assert.match(waterSource, /refresh\(startLat, startLon\)/);
    assert.doesNotMatch(sourceEntitiesSource, /getLocation\(\)\.water/);
    assert.match(sourceEntitiesSource, /\/water\?bbox=/);
});

test('mapped coast publishes its rendered infill as bounded terrain input', () => {
    assert.match(waterSource, /createMappedCoastTerrainSurfaceSampler/);
    assert.match(waterSource, /setTerrainReplacement/);
    assert.match(waterSource, /sampleEvidenceSceneYAtLocal:\s*sampler/);
    assert.match(waterSource, /dependencySnapshot:\s*\(\) => dependencySnapshot/);
});

test('rail presentation follows the live regional style', () => {
    assert.match(railsSource, /regionalLocation\.regionalLocationId/);
    assert.match(railsSource, /rails:regionalStyle/);
});
