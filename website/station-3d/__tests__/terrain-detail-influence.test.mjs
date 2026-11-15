// A moved terrain detail window rebuilds only the receivers whose heights can change:
// the reach of the detail grids added or dropped, and nothing for a released evidence gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainDetailInfluenceChangeBounds } from '../core/terrain-detail-change.js';
import { TerrainReference } from '../core/terrain-grid.js';

const rect = (minX, minZ, maxX, maxZ) => ({ minX, minZ, maxX, maxZ });
const detail = (...rects) => ({ stepM: 4, tileM: 400, rects });
const kept = rect(-600, -600, 500, 500);
const added = rect(-200, -900, 900, 200);
const dropped = rect(-1400, -300, -300, 800);

test('only windows added or dropped count, grown to the grid extent', () => {
    const bounds = terrainDetailInfluenceChangeBounds(detail(kept, dropped), detail(added, kept), { influenceM: 33 });
    assert.deepEqual(bounds, [
        rect(-1433, -333, -267, 833),
        rect(-233, -933, 933, 233),
    ]);
});

test('an unchanged composition changes nothing; a first window is all change', () => {
    assert.deepEqual(terrainDetailInfluenceChangeBounds(detail(added, kept), detail(added, kept)), []);
    assert.deepEqual(terrainDetailInfluenceChangeBounds(null, detail(kept)), [kept]);
});

test('kept windows in a new order may win overlaps differently, so all of them count', () => {
    assert.equal(terrainDetailInfluenceChangeBounds(detail(kept, added), detail(added, kept)).length, 2);
});

test('releasing a pending detail window announces evidence only; a detail merge can mark its bounds exact', () => {
    const grid = { sampleHeight: () => 100 };
    const reference = new TerrainReference(grid, 16, 45.8);
    const events = [];
    reference.onChange((_revision, event) => events.push(event));
    reference.setPendingDetailWindow(rect(0, 0, 400, 400));
    assert.equal(reference.clearPendingDetailWindow(), true);
    reference.replaceGrid(grid, { changedBounds: [kept], exactBounds: true });
    reference.replaceGrid(grid, { changedBounds: [kept] });
    assert.deepEqual(events.map(event => [event.evidenceOnly, event.exactBounds]),
        [[true, false], [false, true], [false, false]]);
});
