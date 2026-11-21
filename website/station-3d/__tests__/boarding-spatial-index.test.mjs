// Boarding scans run every frame and must only visit stops near each visible
// tram, not the complete city stop inventory.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../world/boarding.js', import.meta.url), 'utf8');

test('boarding uses a session-built stop spatial index', () => {
    assert.match(source, /createPointSpatialIndex\(STOP_SPATIAL_CELL_M\)/);
    assert.match(source, /stopSpatialIndex\.add\(\{ stop, x: point\.x, z: point\.z \}/);
    const tick = source.slice(source.indexOf('function tick(dt)'), source.indexOf('// ─── Layer protocol'));
    assert.match(tick, /stopSpatialIndex\.forEachInBounds\(/);
    assert.doesNotMatch(tick, /for \(const stop of stops\)/);
    assert.match(source, /endSession\(\)[\s\S]*stopSpatialIndex\.clear\(\)/);
});
