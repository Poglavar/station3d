// Locks ambient-only water rejection while leaving player movement untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../world/pedestrians.js', import.meta.url), 'utf8');

test('ambient pedestrians reject both sea and inland decor water', () => {
    assert.match(source, /isPointInMappedSea\(x, z\) \|\| isPointInDecorWater\(x, z\)/);
    assert.match(source, /routeCrossesForbiddenSurface\(start, route, isAmbientWaterAt\)/);
    assert.match(source, /if \(!walker\.roofSurfaceId && isAmbientWaterAt\(walker\.x, walker\.z\)\) return false/);
    assert.match(source, /if \(!walker\.roofSurfaceId && isAmbientWaterAt\(proposed\.x, proposed\.z\)\) return false/);
    assert.match(source, /roofActivitySegmentIsSafe\(surface, walker, proposed\)/);
    assert.doesNotMatch(source, /from '\.\.\/modes\/walk\.js'/);
});

test('ambient pedestrian feet follow the live moving terrain reference', () => {
    assert.match(source, /return getTerrainReference\(\) \|\| terrain/);
    assert.match(
        source,
        /evidencePlacementBaseSceneY\(activeTerrainReference\(\), x, z\)/,
        'off-road walkers must not fall back to the anchor plane after the terrain window moves',
    );
    assert.match(source, /terrainChangeSubscription = activeTerrainReference\(\)\?\.onChange/);
    assert.match(
        source,
        /finiteOrNull\(renderedGroundYAt\(x, z, placementY\)\)/,
        'a null rendered-road probe must remain absent instead of coercing to the zero datum',
    );
    assert.match(
        source,
        /return \(renderedY \?\? placementY\) \+ FEET_OFFSET_M/,
        'off-road walkers must fall back to the sampled terrain height',
    );
    assert.match(
        source,
        /function walkerSupportY\(walker, x, z\) \{[\s\S]*if \(!walker\?\.roofSurfaceId\) return feetY\(x, z\);[\s\S]*const currentY = walkerSupportY\(walker, walker\.x, walker\.z\);[\s\S]*if \(walker\.targetKind === 'wait'\)[\s\S]*walker\.mesh\.position\.y = currentY/,
        'station crowds waiting for a route still need to follow terrain revisions',
    );
});
