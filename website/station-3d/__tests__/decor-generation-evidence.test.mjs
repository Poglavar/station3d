// A decor request centre gates genuine source availability, while individual
// placements require physical receivers. A terrain opening cannot deadlock it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('an intentionally cut request centre admits decor and source/road changes invalidate it', () => {
    const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
    let sourceY = 0, roadRevision = 1;
    const terrain = { revision: 2, sourceEvidenceSceneYAtLocal: () => sourceY,
        evidenceSceneYAtLocal: () => { throw new Error('Request availability is not a receiver query'); } };
    const context = vm.createContext({ terrainReference: terrain, groundPaint: {}, anchorLat: 45, anchorLon: 16,
        getRenderedRoadSurfaceRevision: () => roadRevision,
        geoToLocal: () => ({ x: 0, z: 0 }), finiteOrNull: value => Number.isFinite(value) ? value : null });
    vm.runInContext(source.slice(source.indexOf('function decorTerrainGenerationToken('),
        source.indexOf('function awaitDecorTerrain(')), context);
    const token = context.decorTerrainGenerationToken(45, 16);
    assert.ok(token, 'the captured Savska case has source Y=0 and no terrain receiver');
    assert.equal(context.decorTerrainGenerationIsCurrent(token), true);
    sourceY = null;
    assert.equal(context.decorTerrainGenerationToken(45, 16), null, 'missing data is not a flat fallback');
    assert.equal(context.decorTerrainGenerationIsCurrent(token), false);
    sourceY = 0; terrain.revision++;
    assert.equal(context.decorTerrainGenerationIsCurrent(token), false);
    const next = context.decorTerrainGenerationToken(45, 16);
    roadRevision++;
    assert.equal(context.decorTerrainGenerationIsCurrent(next), false, 'mixed physical road generations cannot publish');
    context.terrainReference = null;
    assert.equal(context.decorTerrainGenerationIsCurrent(context.decorTerrainGenerationToken(45, 16)), true,
        'explicit flat worlds retain their declared datum');
});
