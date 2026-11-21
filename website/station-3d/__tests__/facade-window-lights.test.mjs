// Locks the night-window scatter: deterministic, a believable share of windows
// lit, and every lamp inside the brightness band.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    WALL_WINDOW_LIT_FRACTION,
    WALL_WINDOW_MAX_BRIGHTNESS,
    WALL_WINDOW_MIN_BRIGHTNESS,
    wallWindowLightAt,
} from '../core/facade-window-lights.js';

test('the same window always answers the same way, and neighbours differ', () => {
    assert.deepEqual(wallWindowLightAt(3, 5, 7), wallWindowLightAt(3, 5, 7));
    const row = [0, 1, 2, 3, 4, 5, 6, 7].map(col => wallWindowLightAt(col, 2, 1).lit);
    assert.ok(new Set(row).size === 2, 'a row of eight is not all-on or all-off');
    // A different seed is a different building.
    const other = [0, 1, 2, 3, 4, 5, 6, 7].map(col => wallWindowLightAt(col, 2, 99).lit);
    assert.notDeepEqual(row, other);
});

test('about a third of windows are lit across a large facade', () => {
    let lit = 0;
    const cells = 64 * 64;
    for (let col = 0; col < 64; col += 1) {
        for (let row = 0; row < 64; row += 1) {
            if (wallWindowLightAt(col, row, 11).lit) lit += 1;
        }
    }
    const share = lit / cells;
    assert.ok(Math.abs(share - WALL_WINDOW_LIT_FRACTION) < 0.03, `lit share ${share.toFixed(3)}`);
});

test('an unlit window is fully dark and a lit one sits inside the lamp band', () => {
    for (let col = 0; col < 40; col += 1) {
        for (let row = 0; row < 40; row += 1) {
            const light = wallWindowLightAt(col, row, 5);
            if (!light.lit) {
                assert.equal(light.brightness, 0);
                continue;
            }
            assert.ok(light.brightness >= WALL_WINDOW_MIN_BRIGHTNESS);
            assert.ok(light.brightness <= WALL_WINDOW_MAX_BRIGHTNESS);
        }
    }
});

test('the lit fraction is tunable and clamped', () => {
    let none = 0;
    let all = 0;
    for (let col = 0; col < 30; col += 1) {
        for (let row = 0; row < 30; row += 1) {
            if (wallWindowLightAt(col, row, 3, 0).lit) none += 1;
            if (wallWindowLightAt(col, row, 3, 1).lit) all += 1;
        }
    }
    assert.equal(none, 0, 'a fraction of 0 lights nothing');
    assert.equal(all, 900, 'a fraction of 1 lights everything');
    assert.equal(wallWindowLightAt(1, 1, 1, -5).lit, false);
    assert.equal(wallWindowLightAt(1, 1, 1, 5).lit, true);
});

// The window masks already existed — night mode was throwing them away and
// substituting the diffuse map, which lit whole facades instead of windows.
test('night mode lights a material through its own window mask, and the plain wall mask is a real scatter', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../world/buildings.js', import.meta.url), 'utf8');

    // The mask survives the night switch instead of being replaced by mat.map.
    assert.match(source, /const windowMask = windowEmissiveMapByMaterial\.get\(mat\) \|\| null;/);
    assert.match(source, /mat\.emissiveMap = windowMask;/);
    // Both materials that carry a mask record it outside userData. Three.js
    // JSON-clones userData during Material.clone(), which corrupts Texture
    // instances into plain objects and crashes the renderer.
    assert.equal(
        (source.match(/windowEmissiveMapByMaterial\.set\(mat,/g) || []).length,
        2,
        'the tiled wall material and the facade overlay both record their mask',
    );
    assert.doesNotMatch(source, /userData\.windowEmissiveMap/);
    // The old behaviour is still the fallback for a material with no mask.
    assert.match(source, /mat\.emissiveMap = mat\.map \|\| null;/);

    // The plain-wall mask is painted from the scatter, not filled black.
    const painter = source.slice(
        source.indexOf('function getWallEmissiveTexture'),
        source.indexOf('// ─── Procedural normal maps'),
    );
    assert.match(painter, /wallWindowLightAt\(col, row, WALL_WINDOW_SEED\)/);
    assert.match(painter, /if \(!light\.lit\) continue;/);
    assert.ok(
        painter.includes('WALL_ATLAS_GRID'),
        'the mask is painted at atlas resolution so windows line up with the diffuse cells',
    );
    assert.doesNotMatch(painter, /const size = 128;/, 'the single all-black 128px tile is gone');
});
