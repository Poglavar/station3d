// The building capture bakes each merged mesh's translation into its LIVE
// position array. That is destructive: a mesh routed to `kept` after the bake
// still carries mesh.position, so its translation renders twice — which is how
// Rijeka's facade-window overlays floated exactly foundationY away from their
// walls (excluded-material check ran after the bake). Text-level, because
// buildings.js imports THREE and cannot run headlessly; if the shape changes,
// update the test WITH the code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
    fileURLToPath(new URL('../world/buildings.js', import.meta.url)),
    'utf8',
);

function captureFunctionSlice() {
    const start = SOURCE.indexOf('function captureBuildingMeshesForBatching');
    assert.ok(start >= 0, 'captureBuildingMeshesForBatching exists');
    const end = SOURCE.indexOf('\nfunction ', start + 1);
    return SOURCE.slice(start, end > start ? end : undefined);
}

test('every keep-decision precedes the destructive translation bake', () => {
    const fn = captureFunctionSlice();
    const bakeAt = fn.indexOf('+= ox');
    assert.ok(bakeAt >= 0, 'the translation bake is present');
    const lastKeep = fn.lastIndexOf('kept.push');
    assert.ok(lastKeep >= 0, 'meshes can still be kept individual');
    assert.ok(lastKeep < bakeAt,
        'a mesh kept AFTER the in-place bake would render its translation twice '
        + '(baked geometry + still-set mesh.position)');
    const excludedAt = fn.indexOf('overtureMaterialExcluded');
    assert.ok(excludedAt >= 0 && excludedAt < bakeAt,
        'the material-exclusion keep must run before the bake');
});

test('runtime close-facade overlays can never be captured by a building finishing later', () => {
    const fn = captureFunctionSlice();
    assert.match(fn, /!mesh\.userData\?\.facadeCloseDetail/,
        'a resumable building build may span frames while the close LOD appends meshes');
});

test('close-only facade owners never enter the courtyard passage repaint path', () => {
    const repaintStart = SOURCE.indexOf('function* repaintOverlaysForPassages');
    assert.ok(repaintStart >= 0, 'repaintOverlaysForPassages exists');
    const repaintEnd = repaintStart + 1 + SOURCE.slice(repaintStart + 1).search(/\nfunction\*? /);
    const repaint = SOURCE.slice(repaintStart, repaintEnd);
    assert.match(repaint, /if \(record\.passageRepaint && overlapsAnyPassage\(record\.bounds\)/,
        'close-only records have no facade surface for getFacadeOpeningMask');

    const capture = captureFunctionSlice();
    assert.match(capture, /passageRepaint:\s*!!repaintInfo/,
        'captured owners must state which segment contract they carry');
});

// --- the survey (LOD2 mesh) path merges too -------------------------------
//
// It was the last building path emitting one mesh per surface per building:
// 8,495 meshes over 3,083 materials on a Split walk. Render here costs ~7.7 us
// per DRAW CALL and is near-independent of triangle count, so the object count
// is the frame time.
function publishSlice() {
    const start = SOURCE.indexOf('function publish(added)');
    assert.ok(start >= 0, 'the staged survey build still has a publish step');
    const end = SOURCE.indexOf('\n    function ', start + 1);
    return SOURCE.slice(start, end > start ? end : start + 4000);
}

test('the survey build path routes its meshes into the shared aggregates', () => {
    const fn = publishSlice();
    assert.match(fn, /captureBuildingMeshesForBatching\(feature, tileKey, mergeStartIndex, 'gdi'\)/,
        'survey buildings must be merged like Overture ones, or they stay one mesh per surface');
});

test('entities are registered AFTER the merge, over the survivors only', () => {
    const fn = publishSlice();
    const mergeAt = fn.indexOf('captureBuildingMeshesForBatching');
    const registerAt = fn.indexOf('registerBuildingEntityTree');
    assert.ok(mergeAt >= 0 && registerAt >= 0);
    // Registering first would leave the entity registry holding meshes the
    // merge has just taken out of the scene, so a click would resolve to a
    // building that is no longer drawn. Merged geometry keeps its identity
    // through the batcher's per-owner face ranges instead.
    assert.ok(mergeAt < registerAt,
        'registerBuildingEntityTree must run after captureBuildingMeshesForBatching');
});

test('a wall declares its colour family instead of it being pattern-matched', () => {
    // The wall cache key is `<useClass>_<bucket>` and use classes are free
    // text, so a key-shape regex would also match e.g. `measured_123456` and
    // hand that material the wrong family. Identity is stated at creation.
    assert.match(SOURCE, /registerWallColorFamily\(buildingMaterials\[cacheKey\], bucket\)/);
    assert.match(SOURCE, /gdiWallFamily_\$\{bucket % TEXTURE_VARIANTS\}/,
        'one family per TEXTURE variant — the map/normalMap cannot move into a vertex attribute');
});

test('aggregate colour families share one byte-identical shader program', () => {
    assert.match(
        SOURCE,
        /familyMaterial\.customProgramCacheKey = \(\) => 'building-vc-emissive-v1'/,
    );
    assert.doesNotMatch(SOURCE, /`\$\{familyKey\}\|vcEmissive`/);
});

test('facade overlay materials are keyed by STYLE, not by the jitter bucket', () => {
    // Every field of that material comes from styleIdx and the geometry args —
    // getFacadeTexture caches on exactly the same set. Keying on the 64-value
    // bucket instead created up to 10.7x (21x for glass) pixel-identical
    // materials per combination, and two materials can never share a draw call.
    assert.match(SOURCE, /_facadeOverlay_s\$\{styleIdx\}/,
        'the overlay cache key must be built from styleIdx');
    const fn = (() => {
        const start = SOURCE.indexOf('function getFacadeOverlayMaterial');
        assert.ok(start >= 0);
        const end = SOURCE.indexOf('\nfunction ', start + 1);
        return SOURCE.slice(start, end > start ? end : undefined);
    })();
    assert.ok(!/hashObjectId/.test(fn),
        'the bucket is not a property of this material — it must not be computed here');
    // The prefix is load-bearing: the merge exclusion matches on it.
    assert.match(fn, /_facadeOverlay_/);
});
