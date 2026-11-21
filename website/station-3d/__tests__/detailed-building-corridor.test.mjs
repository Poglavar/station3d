// The detailed-building view corridor, checked against the REAL constants the
// buildings layer passes. Two ways this goes wrong silently: a step larger than
// the tile skips whole tile columns and punches holes in the corridor, and a
// distance that does not actually outreach the ring makes the whole thing a
// no-op while looking like a feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DETAILED_BUILDING_AHEAD,
    GTA_DETAILED_BUILDING_AHEAD,
    DETAILED_BUILDING_TILE_M,
    DETAILED_BUILDING_RING,
    DETAILED_BUILDING_KEEP_RING,
    tileIndex,
} from '../core/tile-stream.js';

const BUILDINGS_SOURCE = readFileSync(
    new URL('../world/buildings.js', import.meta.url),
    'utf8',
);

test('GTA keeps a longer, wider detailed runway for continuous city driving', () => {
    assert.ok(GTA_DETAILED_BUILDING_AHEAD.distanceM > DETAILED_BUILDING_AHEAD.distanceM);
    assert.ok(GTA_DETAILED_BUILDING_AHEAD.distanceM <= 1200);
    assert.ok(GTA_DETAILED_BUILDING_AHEAD.halfWidthM > DETAILED_BUILDING_AHEAD.halfWidthM);
    assert.ok(GTA_DETAILED_BUILDING_AHEAD.stepM <= DETAILED_BUILDING_TILE_M);
});

test('the initial view corridor is requested while the loading curtain still holds', () => {
    const onFrameStart = BUILDINGS_SOURCE.indexOf('    onFrame(pose, local) {');
    const onFrameEnd = BUILDINGS_SOURCE.indexOf('\n    endSession()', onFrameStart);
    assert.ok(onFrameStart >= 0 && onFrameEnd > onFrameStart);
    const onFrame = BUILDINGS_SOURCE.slice(onFrameStart, onFrameEnd);
    assert.match(onFrame, /tileSource\.ensureAhead\(/);
    assert.doesNotMatch(onFrame, /if \(!isWorldBuilding\(\)\) \{\s*tileSource\.ensureAhead\(/,
        'waiting until reveal creates a fresh request/build burst without any player movement');
});

// Mirrors applyAheadRequest's sampling in shared-tile-session.js.
function corridorTiles(headingDeg, { distanceM, halfWidthM, stepM }, tileM) {
    const h = headingDeg * Math.PI / 180;
    const forwardX = Math.sin(h);
    const forwardZ = -Math.cos(h);
    const rightX = Math.cos(h);
    const rightZ = Math.sin(h);
    const lateral = halfWidthM > 0 ? [-halfWidthM, 0, halfWidthM] : [0];
    const keys = new Set();
    for (let forwardM = 0; forwardM <= distanceM; forwardM += stepM) {
        for (const lateralM of lateral) {
            const x = forwardX * forwardM + rightX * lateralM;
            const z = forwardZ * forwardM + rightZ * lateralM;
            keys.add(`${tileIndex(x, tileM)}_${tileIndex(z, tileM)}`);
        }
    }
    return keys;
}

test('the step never skips a tile column, in any direction', () => {
    assert.ok(
        DETAILED_BUILDING_AHEAD.stepM <= DETAILED_BUILDING_TILE_M,
        `step ${DETAILED_BUILDING_AHEAD.stepM}m exceeds the ${DETAILED_BUILDING_TILE_M}m tile — the corridor would have holes`,
    );
    // Walk the centreline and confirm consecutive samples never jump more than
    // one tile, which is what a hole would look like.
    for (const heading of [0, 30, 45, 90, 137, 180, 250, 315]) {
        const h = heading * Math.PI / 180;
        let prev = null;
        for (let m = 0; m <= DETAILED_BUILDING_AHEAD.distanceM; m += DETAILED_BUILDING_AHEAD.stepM) {
            const tx = tileIndex(Math.sin(h) * m, DETAILED_BUILDING_TILE_M);
            const tz = tileIndex(-Math.cos(h) * m, DETAILED_BUILDING_TILE_M);
            if (prev) {
                assert.ok(
                    Math.abs(tx - prev[0]) <= 1 && Math.abs(tz - prev[1]) <= 1,
                    `heading ${heading}° jumped from ${prev} to ${[tx, tz]}`,
                );
            }
            prev = [tx, tz];
        }
    }
});

test('reaches meaningfully past the ring the hand-off would otherwise sit at', () => {
    // Ring 2 at 100 m tiles puts LOD1 200–300 m out. The corridor has to clear
    // that by enough to be worth the tiles it costs.
    const ringReachM = DETAILED_BUILDING_RING * DETAILED_BUILDING_TILE_M;
    assert.ok(
        DETAILED_BUILDING_AHEAD.distanceM >= ringReachM * 3,
        `corridor ${DETAILED_BUILDING_AHEAD.distanceM}m barely beats the ${ringReachM}m ring`,
    );
    // …but not past the fog, where the detail is paid for and never seen.
    assert.ok(DETAILED_BUILDING_AHEAD.distanceM <= 1200, 'corridor reaches past the fog horizon');
});

test('corridor tiles land outside keepRing, so eviction exemption is load-bearing', () => {
    // If every corridor tile were inside keepRing this feature would be free and
    // also pointless; the exemption in evictOutsideRing is what keeps them alive.
    const tiles = corridorTiles(0, DETAILED_BUILDING_AHEAD, DETAILED_BUILDING_TILE_M);
    const outside = [...tiles].filter((key) => {
        const [tx, tz] = key.split('_').map(Number);
        return Math.abs(tx) > DETAILED_BUILDING_KEEP_RING || Math.abs(tz) > DETAILED_BUILDING_KEEP_RING;
    });
    assert.ok(outside.length > 0, 'no corridor tile falls outside keepRing');
});

test('stays a corridor — it must not become a second ring', () => {
    // The whole point is paying for reach only along the view. Looking north must
    // not fetch tiles behind or far to the side.
    const tiles = corridorTiles(0, DETAILED_BUILDING_AHEAD, DETAILED_BUILDING_TILE_M);
    for (const key of tiles) {
        const [tx, tz] = key.split('_').map(Number);
        assert.ok(tz <= 0, `heading north fetched a tile behind the observer: ${key}`);
        const lateralTiles = Math.ceil(DETAILED_BUILDING_AHEAD.halfWidthM / DETAILED_BUILDING_TILE_M) + 1;
        assert.ok(Math.abs(tx) <= lateralTiles, `tile ${key} is wider than the corridor`);
    }
    // Sanity on cost: a corridor should be tens of tiles, not hundreds.
    assert.ok(tiles.size < 60, `corridor is ${tiles.size} tiles — too heavy for the payload`);
});
