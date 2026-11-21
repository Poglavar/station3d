import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { TerrainGrid } from '../core/terrain-grid.js';
import { pointInRing } from '../core/mask-query.js';

const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/ground-jelacic-source.json', import.meta.url)));
test('real Dolac polygon identity survives both source tiles and preserves its hole', () => {
    assert.equal(fixture.road.occurrences.length, 2);
    const feature = fixture.road.feature;
    const index = createRoadFeatureIdentityIndex();
    const first = index.identityFor(feature, { tileKey: '-1_-1' });
    const second = index.identityFor(structuredClone(feature), { tileKey: '0_1' });
    assert.equal(first.key, second.key);
    assert.equal(first.sourceId, '-20770250001'); assert.equal(first.provenance.osmType, null);
    const [outer, hole] = feature.geometry.coordinates.map(ring => ring.map(([x,z]) => ({x,z})));
    const insideHole = { x: 15.977265, z: 45.814504 };
    assert.equal(pointInRing(insideHole.x, insideHole.z, outer), true);
    assert.equal(pointInRing(insideHole.x, insideHole.z, hole), true);
    const filled = structuredClone(feature); filled.geometry.coordinates.splice(1);
    assert.notEqual(index.identityFor(filled).geometrySignature, first.geometrySignature);
});

test('real terrain crop retains pixel-centre mapping, height encoding and source provenance', () => {
    const { originalGrid, crop, encoding, source } = fixture.terrain;
    assert.equal(crop.rawHeights.length, crop.width * crop.height);
    assert.equal(crop.sourceIndices.length, crop.rawHeights.length);
    const grid = new TerrainGrid({ grid: crop, encoding, source },
        Uint16Array.from(crop.rawHeights).buffer, { sourceArrayBuffer: Uint8Array.from(crop.sourceIndices).buffer });
    const dx = (originalGrid.bounds.east - originalGrid.bounds.west) / originalGrid.width;
    const dz = (originalGrid.bounds.north - originalGrid.bounds.south) / originalGrid.height;
    for (let y=0; y<crop.height; y++) for (let x=0; x<crop.width; x++) {
        const lon = originalGrid.bounds.west + (crop.x + x + 0.5) * dx;
        const lat = originalGrid.bounds.north - (crop.y + y + 0.5) * dz;
        const expected = crop.rawHeights[y * crop.width + x] * encoding.scaleM + encoding.offsetM;
        assert.ok(Math.abs(grid.sampleHeight(lon, lat) - expected) < 1e-7);
        assert.equal(grid.sourceIndexAtLocation(lon, lat), crop.sourceIndices[y * crop.width + x]);
    }
    assert.equal(source.sources[0].outputVerticalReference, 'EPSG:5730 (EVRF2000 height)');
    assert.equal(source.sources[0].verticalOffsetM, -0.343);
});
