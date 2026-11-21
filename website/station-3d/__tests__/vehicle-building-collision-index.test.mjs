import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
    new URL('../world/courtyard-passages.js', import.meta.url),
    'utf8',
);

test('ambient vehicle collision narrows building candidates through per-tile bounds grids', () => {
    assert.match(source, /import \{ createBoundsGrid \} from '\.\.\/core\/bounds-grid\.js'/);
    assert.match(source, /bounds:\s*footprint\.bbox/);
    assert.match(
        source,
        /vehicleBuildingGridsByTile\.set\(tileKey, createBoundsGrid\(buildings, \{[\s\S]{0,80}cellM:\s*20/,
    );
    assert.match(
        source,
        /grid\.candidatesInBox\([\s\S]{0,180}vehicleBounds\.maxZ/,
        'the exact footprint test must see only AABB-overlapping grid candidates',
    );
    assert.match(source, /vehicleBuildingGridsByTile\.delete\(tileKey\)/);
    assert.match(source, /vehicleBuildingGridsByTile\.clear\(\)/);
});
