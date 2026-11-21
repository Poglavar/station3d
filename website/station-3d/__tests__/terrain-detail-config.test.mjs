// Which native-resolution terrain window a session gets. The location owns it
// for ordinary play; an offline campaign pack bake may bring its own, because a
// baked level pays the LiDAR cost once while a live city would pay it on every
// open — which is exactly why Zagreb has no window of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveTerrainDetailConfig } from '../core/terrain-detail-config.js';

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const BAKE = Object.freeze({ source: 'best-available', meshStepM: 4 });

test('the location window wins whenever the location has one', () => {
    const own = { source: 'best-available', halfSizeM: 550, meshStepM: 4 };
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m', detail: own }, BAKE), own);
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m', detail: own }, null), own);
});

test('a bake window fills in only where the location has none', () => {
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m' }, BAKE), BAKE);
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m' }, null), null);
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m' }, undefined), null);
    assert.equal(resolveTerrainDetailConfig({ source: 'dgu-dtm-20m' }, 'best-available'), null, 'a bare string is not a window');
});

test('a static grid never composes a window, bake or not', () => {
    const grid = { metadataUrl: 'x.json', dataUrl: 'x.bin', detail: { halfSizeM: 500 } };
    assert.equal(resolveTerrainDetailConfig(grid, BAKE), null);
    assert.equal(resolveTerrainDetailConfig(null, BAKE), null);
});

test('the world wires it: terrain resolves through the helper and the cab forwards the campaign bake window', () => {
    const terrain = read('../world/terrain.js');
    assert.match(terrain, /const detailConfig = resolveTerrainDetailConfig\(config, ctx\.campaignTerrainDetail \|\| null\);/);
    assert.match(terrain, /const detailSourceConfig = detailConfig \? \{ \.\.\.config, detail: detailConfig \} : config;/);
    assert.match(terrain, /fetchDetailGrids\(ctx, detailSourceConfig, signal\)/);
    assert.doesNotMatch(terrain, /config\.detail && !config\.metadataUrl/, 'the old inline rule is gone');
    const cab = read('../modes/cab.js');
    assert.match(cab, /ctx\.campaignTerrainDetail = cabState\.campaignScene\?\.authored\?\.campaignTerrainDetail \|\| null;/);
});
