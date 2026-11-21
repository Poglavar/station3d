// Headless unit tests for the LOD handoff arbitration. Proves the far layer is
// told to hide/show a building exactly when the detailed layer builds/drops it,
// with no redundant toggles. Run: npm run test:unit (in website/station-3d).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    publishDetailedTile,
    setDetailed, isDetailed, onDetailedChange, resetDetailed, _resetForTest,
    setDetailedTile, isDetailedTile, isDetailedTileAtLocal, onDetailedTileChange,
} from '../world/building-lod-registry.js';
import { DETAILED_BUILDING_TILE_M } from '../core/tile-stream.js';

beforeEach(() => _resetForTest());

test('setDetailed flips membership and fires listeners with the transition', () => {
    const events = [];
    onDetailedChange((id, d) => events.push([id, d]));
    assert.equal(isDetailed(42), false);

    setDetailed(42, true);
    assert.equal(isDetailed(42), true);
    setDetailed(42, false);
    assert.equal(isDetailed(42), false);

    assert.deepEqual(events, [[42, true], [42, false]]);
});

test('redundant setDetailed does not re-fire listeners', () => {
    let count = 0;
    onDetailedChange(() => count++);
    setDetailed(7, true);
    setDetailed(7, true);   // already detailed — no-op
    setDetailed(7, false);
    setDetailed(7, false);  // already not detailed — no-op
    assert.equal(count, 2);
});

test('null object_id is ignored', () => {
    let count = 0;
    onDetailedChange(() => count++);
    setDetailed(null, true);
    setDetailed(undefined, true);
    assert.equal(count, 0);
});

test('unsubscribe stops delivery', () => {
    let count = 0;
    const off = onDetailedChange(() => count++);
    setDetailed(1, true);
    off();
    setDetailed(2, true);
    assert.equal(count, 1);
});

test('resetDetailed re-shows every currently-detailed building exactly once', () => {
    const shown = [];
    onDetailedChange((id, d) => { if (!d) shown.push(id); });
    setDetailed(1, true);
    setDetailed(2, true);
    setDetailed(3, true);
    resetDetailed();
    assert.deepEqual(shown.sort(), [1, 2, 3]);
    assert.equal(isDetailed(1), false);
    // A second reset with nothing detailed fires nothing.
    shown.length = 0;
    resetDetailed();
    assert.deepEqual(shown, []);
});

test('a late finalizeTile can query current detail state', () => {
    // Mirrors buildings-far.finalizeTile initialising instance visibility.
    setDetailed(99, true);
    const visibleAtBuildTime = !isDetailed(99);
    assert.equal(visibleAtBuildTime, false);   // box starts hidden — detail is present
});

test('detailed-tile region: set/notify/idempotence and reset', () => {
    _resetForTest();
    const events = [];
    onDetailedTileChange((tileKey, isBuilt) => events.push([tileKey, isBuilt]));
    setDetailedTile('3_-2', true);
    setDetailedTile('3_-2', true);          // idempotent — no second event
    assert.equal(isDetailedTile('3_-2'), true);
    assert.equal(isDetailedTile('0_0'), false);
    setDetailedTile('3_-2', false);
    assert.deepEqual(events, [['3_-2', true], ['3_-2', false]]);
    setDetailedTile('1_1', true);
    resetDetailed();                        // clears tiles too, with notifications
    assert.equal(isDetailedTile('1_1'), false);
    assert.deepEqual(events.slice(-2), [['1_1', true], ['1_1', false]]);
});

test('local reveal points resolve against the detailed building tile grid', () => {
    setDetailedTile('1_0', true);
    assert.equal(isDetailedTileAtLocal(131, 3, DETAILED_BUILDING_TILE_M), true);
    assert.equal(isDetailedTileAtLocal(99.99, 3, DETAILED_BUILDING_TILE_M), false);
    assert.equal(isDetailedTileAtLocal(Number.NaN, 0, DETAILED_BUILDING_TILE_M), false);
});

test('tile publication commits the complete replacement before notifying LOD listeners', () => {
    setDetailed(10, true);
    setDetailed(11, true);
    setDetailedTile('2_3', true);

    const observations = [];
    onDetailedChange((objectId, detailed) => observations.push({
        objectId,
        detailed,
        tileDetailed: isDetailedTile('2_3'),
        nextPresent: isDetailed(12),
        removedAbsent: !isDetailed(10),
    }));
    publishDetailedTile('2_3', [11, 12], [10, 11]);

    assert.equal(isDetailedTile('2_3'), true);
    assert.equal(isDetailed(10), false);
    assert.equal(isDetailed(11), true);
    assert.equal(isDetailed(12), true);
    assert.deepEqual(observations.map(event => [event.objectId, event.detailed]), [
        [12, true],
        [10, false],
    ]);
    assert.ok(observations.every(event => (
        event.tileDetailed && event.nextPresent && event.removedAbsent
    )), 'every callback observes the fully committed replacement generation');
});
