// Check actual snapshot copy work and ownership across yields, transfers and
// live-reference replacements without relying on elapsed-time measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGrid, MosaicTerrainGrid, CompositeTerrainGrid, TerrainReference } from '../core/terrain-grid.js';
import * as snapshots from '../core/terrain-snapshot.js';

function grid(width = 257, height = 129, offset = 0) {
    const values = Uint16Array.from({ length: width * height }, (_, i) => (i + offset) % 65536);
    const source = Uint8Array.from({ length: width * height }, (_, i) => i % 3);
    return new TerrainGrid({
        grid: { width, height, bounds: { west: 15.99, east: 16.01, south: 45.79, north: 45.81 } },
        encoding: { scaleM: 0.1, offsetM: 100, noDataValue: 65535 },
    }, values.buffer, { sourceArrayBuffer: source.buffer });
}

function drain(iterator, check = () => {}) {
    for (;;) {
        const step = iterator.next();
        check(step);
        if (step.done) return step.value;
    }
}

test('decoded grids retain sampling/provenance metadata, not duplicate base64 transport payloads', () => {
    const original = grid(3, 3);
    const metadata = { ...original.metadata,
        source: { label: 'fixture', sources: [{ index: 0, key: 'primary' }, { index: 1, key: 'fallback' }] },
        statistics: { sourceCellCounts: [{ key: 'primary', count: 9 }] },
        dataBase64: 'A'.repeat(1_000_000), sourceDataBase64: 'B'.repeat(500_000),
    };
    const decoded = new TerrainGrid(metadata, original.values.buffer, { sourceArrayBuffer: original.sourceValues.buffer });
    assert.equal('dataBase64' in decoded.metadata, false);
    assert.equal('sourceDataBase64' in decoded.metadata, false);
    assert.deepEqual(decoded.metadata.source, metadata.source);
    assert.deepEqual(decoded.metadata.statistics, metadata.statistics);
    assert.deepEqual(decoded.metadata.grid, metadata.grid);
    assert.equal(metadata.dataBase64.length, 1_000_000, 'construction must not mutate the response payload');
    assert.equal(metadata.sourceDataBase64.length, 500_000);
    const snapshot = snapshots.serializeTerrainReference(new TerrainReference(decoded, 16, 45.8));
    assert.ok(JSON.stringify(snapshot.grid.metadata).length < 1000);
});

test('snapshot copies one large grid in bounded chunks and transfers only owned copies', () => {
    const originalGrid = grid();
    const original = new TerrainReference(originalGrid, 16, 45.8, { surfaceStepM: 20 });
    let copied = 0, previous = 0, maxCopy = 0;
    for (const values of [originalGrid.values, originalGrid.sourceValues]) {
        const subarray = values.subarray;
        values.subarray = function(start, end) {
            copied += end - start;
            return subarray.call(this, start, end);
        };
    }
    // The former synchronous drain is intentionally exercised for the red
    // case too: it cannot satisfy the actual per-visit copy contract.
    const iterator = snapshots.serializeTerrainSnapshotSteps
        ? snapshots.serializeTerrainSnapshotSteps(snapshots.captureTerrainSnapshotSource(original))
        : (function*() { return snapshots.serializeTerrainReference(original); })();
    assert.equal(copied, 0, 'creating the task must not copy a height buffer');
    const snapshot = drain(iterator, () => {
        maxCopy = Math.max(maxCopy, copied - previous);
        previous = copied;
        assert.ok(maxCopy <= 16384, `one step copied ${maxCopy} scalar values`);
    });
    assert.equal(copied, originalGrid.values.length + originalGrid.sourceValues.length);
    assert.ok(maxCopy > 0);
    assert.deepEqual(new Uint16Array(snapshot.grid.values), originalGrid.values.subarray(0, originalGrid.values.length));
    assert.deepEqual(new Uint8Array(snapshot.grid.sourceValues), originalGrid.sourceValues.subarray(0, originalGrid.sourceValues.length));
    const transfers = snapshots.terrainSnapshotTransferables(snapshot);
    const delivered = structuredClone(snapshot, { transfer: transfers });
    assert.equal(transfers.every(buffer => buffer.byteLength === 0), true);
    assert.equal(originalGrid.values.length, 257 * 129, 'the live sampler must not be detached');
    const restored = snapshots.deserializeTerrainReference(delivered);
    for (const [x, z] of [[0, 0], [5, 5], [-30, 20], [100, -100]]) {
        assert.equal(restored.sceneYAtLocal(x, z), original.sceneYAtLocal(x, z));
    }
});

test('captured snapshot replays the same mosaic/detail revision after the live grid changes', () => {
    const base = new MosaicTerrainGrid([{ key: 'b', grid: grid(3, 3, 1) }, { key: 'a', grid: grid(3, 3, 2) }]);
    const composite = new CompositeTerrainGrid(base, [grid(3, 3, 3)], { sourceBlendMarginM: 0 });
    const reference = new TerrainReference(composite, 16, 45.8, { surfaceStepM: 20 });
    reference.revision = 7;
    reference.anchorHeightM += 1.9808;
    const expected = snapshots.serializeTerrainReference(reference);
    const source = snapshots.captureTerrainSnapshotSource(reference);
    const partial = snapshots.serializeTerrainSnapshotSteps(source);
    partial.next();
    reference.replaceGrid(grid(3, 3, 100));
    const first = drain(partial);
    assert.deepEqual(first, expected);
    structuredClone(first, { transfer: snapshots.terrainSnapshotTransferables(first) });
    assert.deepEqual(drain(snapshots.serializeTerrainSnapshotSteps(source)), expected,
        'restart regenerates identical buffers, not detached previously sent ones');
    assert.equal(reference.revision, 8);
});

test('many small grids cannot hide a whole-mosaic metadata walk in one visit', () => {
    let visits = 0, copied = 0;
    const items = Array.from({ length: 400 }, (_, key) => {
        const leaf = grid(2, 2, key), metadata = leaf.metadata;
        Object.defineProperty(leaf, 'metadata', { get() { visits++; return metadata; } });
        for (const values of [leaf.values, leaf.sourceValues]) {
            const subarray = values.subarray;
            values.subarray = function(start, end) { copied += end - start; return subarray.call(this, start, end); };
        }
        return { key: String(key), grid: leaf };
    });
    const reference = new TerrainReference(new MosaicTerrainGrid(items), 16, 45.8);
    const iterator = snapshots.serializeTerrainSnapshotSteps(snapshots.captureTerrainSnapshotSource(reference));
    let previousVisits = visits, previousCopies = copied;
    const result = drain(iterator, () => {
        assert.ok(visits - previousVisits <= 1);
        assert.ok(copied - previousCopies <= 16384);
        previousVisits = visits; previousCopies = copied;
    });
    assert.equal(result.grid.items.length, 400);
    assert.equal(copied, 400 * 8);
});

test('cancelling partial snapshot preparation stops further copies and returns no snapshot', () => {
    const terrain = grid();
    const reference = new TerrainReference(terrain, 16, 45.8);
    const iterator = snapshots.serializeTerrainSnapshotSteps(snapshots.captureTerrainSnapshotSource(reference));
    let copied = 0;
    const subarray = terrain.values.subarray;
    terrain.values.subarray = function(start, end) { copied += end - start; return subarray.call(this, start, end); };
    while (!copied) assert.equal(iterator.next().done, false);
    assert.ok(copied < terrain.values.length);
    const stoppedAt = copied;
    assert.deepEqual(iterator.return(), { done: true, value: undefined });
    assert.deepEqual(iterator.next(), { done: true, value: undefined });
    assert.equal(copied, stoppedAt);
    assert.equal(terrain.values.length, 257 * 129);
});
