import test from 'node:test';
import assert from 'node:assert/strict';
import { planGroundPaintUpdate } from '../core/ground-paint-update.js';
import { createGroundPaintTargetPool } from '../core/ground-paint-target-pool.js';
import { createGroundPaintPagePainter } from '../core/ground-paint-page-three.js';
import { GROUND_PAINT_PACKET } from '../core/ground-paint-packet.js';

const receiver = { key: 'ground', verticalBand: 'ground', coverageRevision: 'opening:1' };
const bounds = { minX: 0, minZ: 0, maxX: 16, maxZ: 16 };
const previous = { receiver, bounds, size: 64, disposed: false };
const options = { receiver, bounds, size: 64, blockSize: 16, previous };

test('integer-texel camera shifts copy only overlapping world texels and cover each destination exactly once', () => {
    for (const [dx, dz] of [[4,0], [-4,4], [0,-4], [16,0], [100,-200]]) {
        const nextBounds = { minX: dx, minZ: dz, maxX: dx+16, maxZ: dz+16 };
        const update = planGroundPaintUpdate({ ...options, bounds: nextBounds });
        const coverage = new Uint8Array(64 * 64);
        for (const rect of [...update.copies, ...update.repaints]) {
            assert.ok(rect.width * rect.height <= 256);
            for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
                coverage[(rect.y+y)*64 + rect.x+x]++;
                if ('sourceX' in rect) {
                    assert.equal((rect.sourceX+x+.5)*.25, dx + (rect.x+x+.5)*.25);
                    assert.equal((rect.sourceY+y+.5)*.25, dz + (rect.y+y+.5)*.25);
                }
            }
        }
        assert.ok(coverage.every(count => count === 1));
        assert.equal(update.stats.copiedPixels + update.stats.repaintedPixels, 4096);
    }
    assert.equal(planGroundPaintUpdate({ ...options, bounds: { ...bounds, minX: 4, maxX: 20 } }).stats.copiedPixels, 3072);
});

test('fractional shifts, scale changes and changed receiver openings never reuse old texels', () => {
    for (const override of [
        { bounds: { ...bounds, minX: .1, maxX: 16.1 } },
        { bounds: { ...bounds, maxX: 32 } },
        { receiver: { ...receiver, coverageRevision: 'opening:2' } },
        { receiver: { ...receiver, key: 'bridge-deck' } },
        { previous: { ...previous, disposed: true } },
    ]) {
        const update = planGroundPaintUpdate({ ...options, ...override });
        assert.equal(update.copies.length, 0);
        assert.equal(update.source, null);
        assert.equal(update.stats.repaintedPixels, 4096);
    }
});

test('a source removal dirties both sides of a block boundary and reuses unrelated blocks', () => {
    const update = planGroundPaintUpdate({ ...options, dirtyBounds: [{ minX: 3.9, minZ: 3.9, maxX: 4, maxZ: 4 }] });
    assert.equal(update.repaints.length, 4);
    assert.equal(update.copies.length, 12);
    assert.deepEqual(update.repaints.map(r => [r.x,r.y]), [[0,0],[16,0],[0,16],[16,16]]);
    assert.equal(update.source, previous);
    assert.equal(update.stats.copyBytes, 12 * 256 * 2, 'R8 copy bandwidth includes reads and writes');
});

test('page and invalidation budgets reject oversized work without truncating it', () => {
    assert.throws(() => planGroundPaintUpdate({ ...options, maxBlocks: 15 }), /block budget/);
    assert.throws(() => planGroundPaintUpdate({ ...options, dirtyBounds: [bounds,bounds], maxDirtyBounds: 1 }), /dirty-region budget/);
    assert.throws(() => planGroundPaintUpdate({ ...options, dirtyBounds: [{ ...bounds, maxX: NaN }] }), /dirty bounds/);
});

test('a fixed pool retains active targets, reuses only released targets and disposes each allocation once', () => {
    const pool = createGroundPaintTargetPool({ size: 32, maxTargets: 4, maxTextureBytes: 32*32*4 });
    const leases = Array.from({length: 4}, () => pool.acquire());
    let disposals = 0;
    leases[0].target.addEventListener('dispose', () => disposals++);
    assert.equal(new Set(leases.map(lease => lease.target)).size, 1);
    assert.equal(new Set(leases.map(lease => lease.layer)).size, 4);
    assert.equal(pool.acquire(), null);
    assert.equal(pool.stats().textureBytes, 4096);
    assert.equal(leases[2].release(), true);
    assert.equal(leases[2].release(), false);
    const successor = pool.acquire();
    assert.equal(successor.target, leases[2].target);
    assert.equal(successor.layer, leases[2].layer);
    assert.equal(disposals, 0);
    assert.equal(pool.acquire(), null);
    assert.equal(pool.dispose(), true);
    assert.equal(pool.dispose(), false);
    assert.equal(disposals, 1);
    assert.ok(leases.every(lease => lease.released));
    successor.release();
    assert.throws(() => pool.acquire(), /closed/);
    assert.throws(() => createGroundPaintTargetPool({ size: 2048, maxTargets: 4, maxTextureBytes: 16_000_000 }), /budget/);
    const desktop = createGroundPaintTargetPool({ size: 2048, maxTargets: 4, maxTextureBytes: 100_000_000 });
    assert.equal(desktop.stats().maxTextureBytes, 16_777_216);
    desktop.dispose();
});

test('one painter owns one candidate; cancellation and context loss release its staging lease', () => {
    const listeners = new Map();
    const renderer = { isWebGLRenderer: true, capabilities: { maxTextureSize: 64 }, initTexture() {}, domElement: {
        addEventListener: (event, listener) => listeners.set(event, listener),
        removeEventListener: event => listeners.delete(event),
    } };
    const painter = createGroundPaintPagePainter({ renderer });
    const pool = createGroundPaintTargetPool({ size: 64, maxTargets: 1, maxTextureBytes: 64*64 });
    const packet = { contract: GROUND_PAINT_PACKET, size: 64, receiver, receiverBounds: bounds, bounds, draws: [], styles: { recipes: [] },
        update: planGroundPaintUpdate({ receiver, bounds, size: 64 }) };
    const first = painter.createTask({ packet, targetLease: pool.acquire() });
    assert.throws(() => painter.createTask({ packet }), /already has a candidate/);
    assert.equal(pool.acquire(), null);
    assert.equal(first.dispose(), true);
    assert.equal(first.dispose(), false);
    const next = painter.createTask({ packet, targetLease: pool.acquire() });
    listeners.get('webglcontextlost')();
    assert.equal(next.state, 'disposed');
    assert.equal(painter.stats().active, false);
    assert.equal(pool.stats().leased, 0);
    assert.throws(() => next.step(), /disposed/);
    listeners.get('webglcontextrestored')();
    const afterRestore = painter.createTask({ packet, targetLease: pool.acquire() });
    painter.dispose();
    assert.equal(afterRestore.state, 'disposed');
    assert.equal(pool.stats().leased, 0);
    assert.equal(listeners.size, 0);
    assert.throws(() => painter.createTask({ packet }), /closed/);
    pool.dispose();
});
