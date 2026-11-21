// Exact fountain geometry has one render owner: mapped basins are polygon
// surfaces, while only point-mapped fountains use the circular generic prop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const decorSource = await readFile(new URL('../world/decor.js', import.meta.url), 'utf8');

test('greenery consumes exact fountain semantics and builds outline-following rims', () => {
    assert.match(decorSource, /semantic\s*===\s*['"]fountain['"]/);
    assert.match(decorSource, /surfaceType\s*=\s*isFountainSurface\s*\?\s*['"]fountain['"]/);
    assert.match(decorSource, /buildFountainRimMesh\(fountainPolygons\)/);
    assert.match(decorSource, /mesh\.name\s*=\s*['"]DecorFountainRims['"]/);
});

test('the generic fountain feed is point-only and has no source-id exception', () => {
    assert.match(decorSource, /point-mapped OSM amenity=fountain/);
    assert.doesNotMatch(decorSource, /isStaticallyBlockedDecorSourceId|a1175500756/);
    assert.doesNotMatch(decorSource, /basins reduced to centroid|equivalent-area radius/);
});
