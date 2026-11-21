// The one rule that separates terrain still streaming from terrain the DGU
// model will never have. Told apart wrongly, a kerb, road or alignment on a
// harbour mole rejects the shared ground generation on every pass — and since
// the coast collar is prepared last inside that candidate, the visible symptom
// is a city with no shore rather than an error anyone reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPermanentTerrainGap, permanentTerrainGapTest } from '../core/terrain-evidence-gap.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sea = contains => ({ mappedWater: { contains } });

test('only the sea mask proves a gap permanent, and only when it says so exactly', () => {
    assert.equal(isPermanentTerrainGap(sea(() => true), 10, 20), true);
    assert.equal(isPermanentTerrainGap(sea(() => false), 10, 20), false);
    // The mask is asked about the point it was given, not a remembered one.
    const asked = [];
    isPermanentTerrainGap(sea((x, z) => { asked.push([x, z]); return true; }), -75.5, 771.25);
    assert.deepEqual(asked, [[-75.5, 771.25]]);
});

test('anything short of a mask saying yes leaves the gap retryable', () => {
    // Retrying is the safe direction: it costs a rejected candidate, while a
    // wrong "permanent" silently drops real geometry that was about to arrive.
    for (const ground of [null, undefined, {}, { mappedWater: null }, { mappedWater: {} },
        sea(() => undefined), sea(() => null), sea(() => 1), sea(() => 'yes')]) {
        assert.equal(isPermanentTerrainGap(ground, 0, 0), false, JSON.stringify(ground) ?? String(ground));
    }
});

test('the bound test is absent without a mask, so callers cannot silently treat one as proof', () => {
    assert.equal(permanentTerrainGapTest(null), null);
    assert.equal(permanentTerrainGapTest({}), null);
    assert.equal(permanentTerrainGapTest({ mappedWater: {} }), null);
    const bound = permanentTerrainGapTest(sea((x) => x > 100));
    assert.equal(typeof bound, 'function');
    assert.equal(bound(200, 0), true);
    assert.equal(bound(50, 0), false);
});

test('every layer that refuses to invent a height shares this one definition', () => {
    // Three call sites, three different remedies — a cleared curb tile, an
    // uncompiled alignment, an excluded road — but one rule for when they apply.
    for (const [file, marker] of [
        ['../world/curbs.js', /isPermanentTerrainGap\(state\?\.ground, x, z\)/],
        ['../core/road-vertical-alignment.js', /permanentTerrainGapTest\(\{ mappedWater, terrain: terrainRead \}\)/],
        ['../world/roads.js', /isPermanentTerrainGap\(ground,/],
    ]) {
        const source = read(file);
        assert.match(source, /from '\.[./]*\/?core\/terrain-evidence-gap\.js'|from '\.\/terrain-evidence-gap\.js'/,
            `${file} does not import the shared rule`);
        assert.match(source, marker, `${file} does not use the shared rule`);
    }
});

test('a road with a permanent gap is excluded at the failing sample, which the receiver tolerates, not reported unavailable', () => {
    const roads = read('../world/roads.js');
    assert.match(roads, /if \(!isPermanentTerrainGap\(ground, point\.x, point\.z\)\) \{[\s\S]*?return 'defer';\s*\}\s*omission = Object\.freeze\(\{ kind: 'excluded', reason: 'terrain-evidence',\s*\n?\s*x: point\.x, z: point\.z \}\);/,
        'the ring task judges the gap at its own sample by the shared rule and names the point');
    assert.match(roads, /omission = ringTask\.omission\?\.\(\)\s*\n?\s*\|\| Object\.freeze\(\{ kind: 'unavailable', reason: 'terrain-evidence' \}\)/,
        'the feature takes the ring\'s decision; a ring that cannot say why still leaves the receiver retrying');
    // A verdict at the feature's centre held Split's port ground for good:
    // way 126354021 has 20 m data at its centre and NoData at its west end.
    assert.doesNotMatch(roads, /kind: permanent \? 'excluded' : 'unavailable'/);
});

// A terrain read whose loaded core mosaic owns the point, with no detail
// window pending there, and no sample: authoritative NoData.
const terrain = ({ core = true, withheld = false, evidence = null } = {}) => ({
    hasLoadedCoreCoverageAtLocal: () => core,
    evidenceWithheldAtLocal: () => withheld,
    evidenceSceneYAtLocal: () => evidence,
});

test('the loaded terrain mosaic proves a gap permanent where its NoData is authoritative', () => {
    // The Split port apron: 11.5 m outside the sea polygon, no DTM sample.
    assert.equal(isPermanentTerrainGap({ mappedWater: { contains: () => false }, terrain: terrain() }, -150.8, 705.5), true);
    // The read may also be the terrain itself, as the alignment compiler holds it.
    assert.equal(isPermanentTerrainGap(terrain(), 0, 0), true);
    assert.equal(permanentTerrainGapTest({ terrain: terrain() })(1, 2), true);
    assert.equal(permanentTerrainGapTest(terrain())(1, 2), true);
});

test('terrain that has not finished arriving leaves the gap retryable', () => {
    // Core cell not loaded yet: the sample may still come.
    assert.equal(isPermanentTerrainGap({ terrain: terrain({ core: false }) }, 0, 0), false);
    // A pending 1 m window withholds evidence until it lands.
    assert.equal(isPermanentTerrainGap({ terrain: terrain({ withheld: true }) }, 0, 0), false);
    // A real sample is not a gap at all.
    assert.equal(isPermanentTerrainGap({ terrain: terrain({ evidence: 3.2 }) }, 0, 0), false);
    // A read without the coverage predicates cannot vouch for anything.
    assert.equal(isPermanentTerrainGap({ terrain: { evidenceSceneYAtLocal: () => null } }, 0, 0), false);
    assert.equal(permanentTerrainGapTest({ terrain: { evidenceSceneYAtLocal: () => null } }), null);
});
