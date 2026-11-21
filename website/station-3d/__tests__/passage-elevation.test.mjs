// Headless unit tests for the vertical half of the courtyard-passage layer:
// the band a road's shader cut opens, and the band a planner track cut leaves
// exposed on a building face. Both exist because the passage builder measures
// every height from a building's OWN base (the tile subtracts z_min off) while
// buildings.js stands that building on the DGU terrain — so on sloped ground
// the two spaces are metres apart, which is what left passage arches and cut
// patches floating in mid-air at Divulje. Run: npm run test:unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    passageCutBand,
    trackCutPatchBand,
    PASSAGE_HEIGHT_M,
} from '../world/passage-geometry.js';

test('flat world: one passage cuts from the ground to its arch', () => {
    const band = passageCutBand([{ baseY: 0, archHeight: 4.2 }]);
    assert.deepEqual(band, { bottomY: 0, topY: 4.2 });
});

test('the shortest arch on a road still governs the cut ceiling', () => {
    const band = passageCutBand([
        { baseY: 0, archHeight: 5 },
        { baseY: 0, archHeight: 3.4 },
    ]);
    assert.equal(band.bottomY, 0);
    assert.equal(band.topY, 3.4, 'a 5 m cut would slice the low wing’s roof open');
});

test('a terrain-lifted building carries its cut band with it', () => {
    // The Divulje case: the scene anchor sits ~22 m above the ground here, so
    // the building base is negative and the cut must follow it down.
    const band = passageCutBand([{ baseY: -22.4, archHeight: 4.2 }]);
    assert.equal(band.bottomY, -22.4);
    assert.equal(+band.topY.toFixed(2), -18.2);
    assert.ok(band.topY < 0, 'the cut must not sit up on the anchor plane');
});

test('two buildings at different heights on one road get a covering band', () => {
    const band = passageCutBand([
        { baseY: -22.4, archHeight: 4.2 },
        { baseY: -20.9, archHeight: 4.2 },
    ]);
    assert.equal(band.bottomY, -22.4, 'floor reaches the deeper building');
    assert.equal(+band.topY.toFixed(2), -18.2, 'ceiling stays at the lowest arch top');
    assert.ok(band.topY > band.bottomY);
});

test('no registered passage falls back to the full potential cut', () => {
    assert.deepEqual(passageCutBand([]), { bottomY: 0, topY: PASSAGE_HEIGHT_M });
    assert.deepEqual(passageCutBand(undefined), { bottomY: 0, topY: PASSAGE_HEIGHT_M });
});

test('non-finite requirements are ignored rather than poisoning the band', () => {
    const band = passageCutBand([
        { baseY: null, archHeight: 4.2 },
        { baseY: -3, archHeight: 4.2 },
    ]);
    assert.equal(band.bottomY, -3, 'a null base must not become a real 0 m floor');
});

test('flat world: a to-the-sky cut patches the building full height', () => {
    const band = trackCutPatchBand(0, 14, -120, 120, 0.6);
    assert.deepEqual(band, { baseY: 0, topY: 14, height: 14 });
});

test('a terrain-lifted building is patched over its own extent, not the anchor plane', () => {
    const band = trackCutPatchBand(-22.4, 14, -120, 120, 0.6);
    assert.equal(band.baseY, -22.4);
    assert.equal(+band.topY.toFixed(2), -8.4);
    assert.equal(+band.height.toFixed(2), 14);
});

test('a cut band that clears the building entirely owes no patch', () => {
    // The bug as shipped: the cut resting on the anchor plane [0, 240] while
    // the building spans [-22.4, -8.4]. No fragment of it is discarded, so a
    // patch there is a wall standing in open air.
    assert.equal(trackCutPatchBand(-22.4, 14, 0, 240, 0.6), null);
    assert.equal(trackCutPatchBand(0, 14, 30, 50, 0.6), null, 'cut above the roof');
    assert.equal(trackCutPatchBand(0, 14, -50, -30, 0.6), null, 'cut below the base');
});

test('a partial cut is clamped to the overlap on both ends', () => {
    const band = trackCutPatchBand(-22.4, 14, -15, -10, 0.6);
    assert.equal(band.baseY, -15);
    assert.equal(band.topY, -10);
    assert.equal(band.height, 5);
});

test('slivers below the minimum patch height are refused', () => {
    assert.equal(trackCutPatchBand(-22.4, 14, -8.8, -8.45, 0.6), null);
    assert.ok(trackCutPatchBand(-22.4, 14, -9.4, -8.45, 0.6));
});

test('a missing building base is refused, never treated as sea level', () => {
    assert.equal(trackCutPatchBand(null, 14, -120, 120, 0.6), null);
    assert.equal(trackCutPatchBand(-22.4, undefined, -120, 120, 0.6), null);
});
