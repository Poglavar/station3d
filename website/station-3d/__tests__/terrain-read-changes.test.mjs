// Completeness of terrain read change sets: any terrain query whose recorded
// evidence misses the change set between two captured snapshots must answer
// the same from both, including answers served from shared corner caches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompositeTerrainGrid, MosaicTerrainGrid, TerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import { captureTerrainReadSnapshot, terrainReadChanges } from '../core/terrain-snapshot.js';
import { createGroundReadEvidence, freezeGroundReadEvidence, groundReadEvidenceDependsOn,
    withGroundReadEvidence } from '../core/ground-read-evidence.js';

const ANCHOR = { lon: 16, lat: 45 };
const M_LAT = 111194.93, M_LON = M_LAT * Math.cos(ANCHOR.lat * Math.PI / 180);
const lon = x => ANCHOR.lon + x / M_LON, lat = z => ANCHOR.lat - z / M_LAT;

// A grid over local [x0, x1] × [z0, z1] with `cells` samples per side.
function grid(x0, z0, x1, z1, height, cells = 16) {
    const values = new Uint16Array(cells * cells);
    for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
        const x = x0 + (x1 - x0) * column / (cells - 1), z = z1 - (z1 - z0) * row / (cells - 1);
        values[row * cells + column] = Math.round((100 + height(x, z)) / .01);
    }
    return new TerrainGrid({ grid: { width: cells, height: cells,
        bounds: { west: lon(x0), east: lon(x1), south: lat(z1), north: lat(z0) } },
    encoding: { scaleM: .01, offsetM: 0, noDataValue: 65535 } }, values.buffer);
}
const hills = (x, z) => Math.sin(x / 37) * 6 + Math.cos(z / 29) * 4;
const tile = (i, j, height = hills) => grid(i * 200, j * 200, (i + 1) * 200, (j + 1) * 200, height);
const mosaic = tiles => new MosaicTerrainGrid(tiles.map(([key, value]) => ({ key, grid: value })));
const base = [['a', tile(-1, -1)], ['b', tile(0, -1)], ['c', tile(-1, 0)], ['d', tile(0, 0)]];

function reference(gridValue, { detail = null, pending = null } = {}) {
    const terrain = new TerrainReference(gridValue, ANCHOR.lon, ANCHOR.lat, { surfaceStepM: 20, detail });
    terrain.setPendingDetailWindow(pending);
    return terrain;
}

const QUERIES = [
    ['sceneYAtLocal', (t, x, z) => t.sceneYAtLocal(x, z)],
    ['evidenceSceneYAtLocal', (t, x, z) => t.evidenceSceneYAtLocal(x, z)],
    ['sourceSceneYAtLocal', (t, x, z) => t.sourceSceneYAtLocal(x, z)],
    ['normalAtLocal', (t, x, z) => t.normalAtLocal(x, z, 6)],
    ['evidenceNormalAtLocal', (t, x, z) => t.evidenceNormalAtLocal(x, z, 6)],
    ['hasLoadedCoreCoverageAtLocal', (t, x, z) => t.hasLoadedCoreCoverageAtLocal(x, z)],
    ['evidenceWithheldAtLocal', (t, x, z) => t.evidenceWithheldAtLocal(x, z)],
    ['sampleStepMAtLocal', (t, x, z) => t.sampleStepMAtLocal(x, z)],
    ['sampleStepMForBounds', (t, x, z) => t.sampleStepMForBounds({ minX: x - 30, minZ: z - 30, maxX: x + 30, maxZ: z + 30 })],
    ['heightAt', (t, x, z) => t.heightAt(lon(x), lat(z))],
    ['evidenceSlopeAlongHeadingDeg', (t, x, z) => t.evidenceSlopeAlongHeadingDeg(lon(x), lat(z), 40, 12)],
];

function assertComplete(before, after, label) {
    const changes = terrainReadChanges(before, after);
    assert.equal(changes.full, false, `${label}: ${changes.fullReason}`);
    let skipped = 0, dependent = 0;
    for (let index = 0; index < 700; index++) {
        const x = ((index * 37) % 380) - 190 + (index % 7) * .41, z = ((index * 53) % 380) - 190 + (index % 5) * .23;
        for (const [name, query] of QUERIES) {
            const evidence = createGroundReadEvidence();
            const answer = withGroundReadEvidence(evidence, () => query(before, x, z));
            if (groundReadEvidenceDependsOn(freezeGroundReadEvidence(evidence), changes)) { dependent++; continue; }
            skipped++;
            assert.deepEqual(query(after, x, z), answer, `${label}: ${name} at ${x.toFixed(2)},${z.toFixed(2)} changed without evidence`);
        }
    }
    assert.ok(skipped > 500 && dependent > 200, `${label}: ${skipped} skipped, ${dependent} dependent`);
    return changes;
}

test('replacing one mosaic tile changes only reads near it', () => {
    const live = reference(mosaic(base));
    const before = captureTerrainReadSnapshot(live);
    live.replaceGrid(mosaic([...base.slice(0, 3), ['d', tile(0, 0, (x, z) => hills(x, z) + 3)]]));
    assertComplete(before, captureTerrainReadSnapshot(live), 'tile');
});

test('a streamed detail grid and fine rects change only reads that reach them', () => {
    const detailGrid = grid(-60, -60, 60, 60, (x, z) => hills(x, z) + Math.sin(x) * .5, 121);
    const live = reference(mosaic(base));
    const before = captureTerrainReadSnapshot(live);
    live.replaceGrid(new CompositeTerrainGrid(mosaic(base), [detailGrid]),
        { detail: { stepM: 1, tileM: 20, rects: [{ minX: -40, minZ: -40, maxX: 40, maxZ: 40 }] } });
    assertComplete(before, captureTerrainReadSnapshot(live), 'detail');
});

test('a pending detail window withholds evidence only where it lies', () => {
    const live = reference(mosaic(base));
    const before = captureTerrainReadSnapshot(live);
    live.setPendingDetailWindow({ minX: 20, minZ: 20, maxX: 90, maxZ: 90 });
    assertComplete(before, captureTerrainReadSnapshot(live), 'pending');
    assert.equal(terrainReadChanges(before, captureTerrainReadSnapshot(reference(mosaic(base)))).full, false);
    const same = captureTerrainReadSnapshot(live);
    assert.equal(terrainReadChanges(same, captureTerrainReadSnapshot(live)).empty, true, 'recapture is not a change');
});
