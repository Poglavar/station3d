import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';

const drain = steps => { for (;;) { const n = steps.next(); if (n.done) return n.value; } };
const part = (id, x, y) => ({ id, drivable: true,
    positions: new Float32Array([x - 1, y, -1, x + 1, y, -1, x + 1, y, 1, x - 1, y, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]) });
const limits = bounds => ({ maxOwners: 8, maxCells: 64, maxCellParts: 128, queryBounds: bounds });

test('private road read snapshots combine replacements with retained owners and clean up', () => {
    const r = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    r.replace('near', [part('near-old', 0, 1)]); r.replace('middle', [part('middle-old', 100, 5)]); r.replace('far', [part('far-old', 500, 7)]);
    const tx = drain(r.preparePublicationSteps([
        r.prepare('near', [part('near-new', 0, 3)]), r.prepare('middle', []),
    ], { maxOwners: 8, maxCells: 64, maxCellParts: 128 }));
    const readNear = drain(tx.captureReadSnapshotSteps({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, limits({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 })));
    assert.equal(readNear.supportYAt(0, 0), 3);
    assert.throws(() => readNear.supportYAt(500, 500), /coverage/);
    assert.equal(r.supportYAt(0, 0), 1); assert.equal(r.supportYAt(500, 0), 7);
    readNear.release();
    const readFar = drain(tx.captureReadSnapshotSteps({ minX: 90, minZ: -10, maxX: 510, maxZ: 10 }, limits({ minX: 90, minZ: -10, maxX: 510, maxZ: 10 })));
    assert.equal(readFar.supportYAt(100, 0), null);
    assert.equal(readFar.supportYAt(500, 0), 7);
    assert.equal(tx.commit(), true); assert.equal(tx.finalize(), true);
    assert.equal(r.supportYAt(0, 0), 3); assert.equal(r.supportYAt(100, 0), null); assert.equal(r.supportYAt(500, 0), 7);
    readFar.release(); assert.equal(r.debugState().readSnapshots, 0);
    const rollbackTx = drain(r.preparePublicationSteps([
        r.prepare('near', [part('near-rollback', 0, 4)]),
    ], { maxOwners: 8, maxCells: 64, maxCellParts: 128 }));
    assert.equal(rollbackTx.commit(), true); assert.equal(r.supportYAt(0, 0), 4);
    assert.equal(rollbackTx.rollback(), true); assert.equal(r.supportYAt(0, 0), 3);
    assert.equal(rollbackTx.discard(), true);
});

test('active read becomes stale on live intersecting change while candidate remains current', () => {
    const r = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    r.replace('live', [part('live-old', 500, 7)]);
    const tx = drain(r.preparePublicationSteps([r.prepare('replacement', [part('replacement-next', 0, 3)])], { maxOwners: 8, maxCells: 64, maxCellParts: 128 }));
    const read = drain(tx.captureReadSnapshotSteps({ minX: 490, minZ: -10, maxX: 510, maxZ: 10 }, limits({ minX: 490, minZ: -10, maxX: 510, maxZ: 10 })));
    assert.equal(read.supportYAt(500, 0), 7);
    r.replace('live', [part('live-current', 500, 9)]);
    assert.equal(read.isCurrent(), false); assert.equal(tx.isCurrent(), true);
    read.release();
    const recaptured = drain(tx.captureReadSnapshotSteps({ minX: 490, minZ: -10, maxX: 510, maxZ: 10 }, limits({ minX: 490, minZ: -10, maxX: 510, maxZ: 10 })));
    assert.equal(recaptured.supportYAt(500, 0), 9); recaptured.release();
    assert.equal(tx.commit(), true); assert.equal(tx.finalize(), true); assert.equal(r.debugState().readSnapshots, 0);
});

test('read snapshot capacity is bounded and recovers after release', () => {
    const r = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    r.replace('one', [part('one', 0, 1)]);
    const tx = drain(r.preparePublicationSteps([], { maxOwners: 8, maxCells: 16, maxCellParts: 64,
        queryBounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 } }));
    const reads = Array.from({ length: 8 }, () => drain(tx.captureReadSnapshotSteps({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, limits({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }))));
    assert.throws(() => drain(tx.captureReadSnapshotSteps({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, limits({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }))), /capacity/);
    reads[0].release(); const recovered = drain(tx.captureReadSnapshotSteps({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, limits({ minX: -10, minZ: -10, maxX: 10, maxZ: 10 })));
    recovered.release(); for (const read of reads.slice(1)) read.release(); tx.discard(); r.clear(); assert.equal(r.debugState().readSnapshots, 0);
});

test('read cancellation, capacity failure and clear release partial or completed snapshots', () => {
    const r = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    r.replace('owners', [part('a', 0, 1), part('b', 0, 2)]);
    const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    assert.throws(() => drain(r.captureReadSnapshotSteps(bounds, { maxCells: 1, maxCellParts: 64 })), /cell capacity/);
    assert.equal(r.debugState().readSnapshots, 0);
    assert.throws(() => drain(r.captureReadSnapshotSteps(bounds, { maxCells: 16, maxCellParts: 1 })), /part capacity/);
    assert.equal(r.debugState().readSnapshots, 0);
    const partial = r.captureReadSnapshotSteps(bounds, { maxCells: 16, maxCellParts: 64 });
    assert.equal(partial.next().done, false); assert.equal(r.debugState().readSnapshots, 1);
    partial.return(); assert.equal(r.debugState().readSnapshots, 0);
    const tx = drain(r.preparePublicationSteps([r.prepare('replacement', [part('next', 100, 3)])],
        { maxOwners: 8, maxCells: 16, maxCellParts: 64 }));
    const read = drain(tx.captureReadSnapshotSteps(bounds, { maxCells: 16, maxCellParts: 64 }));
    assert.equal(read.supportYAt(0, 0), 2); assert.equal(r.debugState().readSnapshots, 1);
    r.clear(); assert.equal(r.debugState().readSnapshots, 0); assert.equal(read.isCurrent(), false);
    assert.throws(() => read.supportYAt(0, 0), /released/);
    assert.equal(tx.isCurrent(), false); tx.discard();
});
