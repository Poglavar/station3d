// Where a stop's boarding crowd stands. This exists because passengers were
// reported floating in the sky over Split, and the measurement was unambiguous:
// a level-0 SURFACE stop, elevM 41.12 (absolute EVRF2000 a.s.l.) plus terrain
// scene-Y 1.02, put the platform at 42.20 — the ground counted twice.
//
// The same failure had already been fixed once for the station shelters in
// platforms.js ("floating tens of metres up"); the crowd simply never learned
// it. It only became reachable when the planner cab began passing absolute
// elevations at all — before that every stop carried level x LEVEL_HEIGHT, which
// genuinely is a height above the ground.

import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFeetSceneY } from '../core/photo-boarding-placement.js';

// Split's datum: absolute 41.12 a.s.l. is scene-Y ~4.05 (a.s.l. − anchor height).
const ANCHOR = 37.07;
const toScene = (h) => h - ANCHOR;

test('an absolute elevation is converted, never stacked on the terrain', () => {
    const y = platformFeetSceneY({
        elevM: 41.12,
        platformOffsetM: 0.06,
        absoluteToSceneY: toScene,
        relativeFeetY: 41.18,   // what the old path would have used
        terrainSceneY: 1.02,
    });
    assert.ok(Math.abs(y - 4.11) < 0.01, `expected ~4.11, got ${y}`);
    assert.ok(y < 10, 'the reported bug: 42.20, a surface platform forty metres up');
});

test('a relative height still gets the terrain added', () => {
    // level x LEVEL_HEIGHT IS above the ground, so this path must not change.
    const y = platformFeetSceneY({
        elevM: null,
        relativeFeetY: 0.06,
        terrainSceneY: 12.5,
    });
    assert.equal(y, 12.56);
});

test('an elevated stop keeps its platform offset above the rail', () => {
    const surface = platformFeetSceneY({
        elevM: 41.12, platformOffsetM: 0.06, absoluteToSceneY: toScene,
    });
    const elevated = platformFeetSceneY({
        elevM: 41.12, platformOffsetM: 1.1, absoluteToSceneY: toScene,
    });
    assert.ok(Math.abs((elevated - surface) - 1.04) < 1e-9,
        'the offset is what separates a surface stop from a raised platform');
});

test('no converter means the relative path, not a converted zero', () => {
    // Falling through is right; treating a missing converter as 0 would drop the
    // crowd to the datum, which looks like a fix and is a different bug.
    const y = platformFeetSceneY({
        elevM: 41.12, platformOffsetM: 0.06,
        absoluteToSceneY: null, relativeFeetY: 41.18, terrainSceneY: 1.02,
    });
    assert.equal(y, 42.2, 'unconverted absolute + terrain — the old behaviour, unchanged');
});

test('a converter that cannot answer falls through instead of inventing a ground', () => {
    for (const bad of [() => NaN, () => null, () => undefined, () => 'high']) {
        const y = platformFeetSceneY({
            elevM: 41.12, platformOffsetM: 0.06,
            absoluteToSceneY: bad, relativeFeetY: 41.18, terrainSceneY: 1.02,
        });
        assert.equal(y, 42.2, 'fell through to the relative path');
    }
});

test('a non-finite elevM is not an absolute elevation', () => {
    // Number(null) is 0 and Number.isFinite(0) is true — the trap this codebase
    // keeps hitting. A missing elevation must not read as "absolute 0 m a.s.l.",
    // which would bury the crowd at the datum.
    for (const missing of [null, undefined, NaN, '41.12']) {
        const y = platformFeetSceneY({
            elevM: missing, absoluteToSceneY: toScene,
            relativeFeetY: 0.06, terrainSceneY: 9,
        });
        assert.equal(y, 9.06, `treated as relative: ${String(missing)}`);
    }
});

test('defaults do not fabricate a height', () => {
    assert.equal(platformFeetSceneY(), 0);
    assert.equal(platformFeetSceneY({}), 0);
});
