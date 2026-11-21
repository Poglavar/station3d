import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishedGroundReadSlot } from '../core/published-ground-read.js';
import { ownReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { SURFACE_CLASS } from '../core/surface-hierarchy.js';

const run = steps => { for (;;) { const n = steps.next(); if (n.done) return n.value; } };
const claim = { surfaceClass: SURFACE_CLASS.TERRAIN };
const triangle = [{ x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: 0, y: 0, z: 2 }];
const area = faces => faces.reduce((sum, [a, b, c]) => sum
    + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2, 0);
function fixture() {
    const slot = createPublishedGroundReadSlot(), registry = createSurfacePublicationRegistry(), inputs = [];
    let generation = 0;
    function prepare(height, guard = () => true) {
        const tx = slot.begin({ isCurrent: guard });
        let owners = 0;
        const lease = () => {
            owners++; let held = true;
            return { retain() { assert.ok(held, 'only a retained owner may derive a read'); return lease(); },
                release() { if (!held) return false; held = false; owners--; return true; } };
        };
        const openings = run(createSurfaceOpeningReadSteps({ authored: [{
            ring: [{ x: -.5, z: -.5 }, { x: .5, z: -.5 }, { x: .5, z: .5 }, { x: -.5, z: .5 }],
            minY: -.5, maxY: 1,
        }], limits: GROUND_GENERATION_LIMITS.openings,
        isCurrent: () => tx.published ? tx.queryCurrent() : guard() }));
        const read = ownReadSnapshot({ terrain: Object.freeze({ evidenceSceneYAtLocal() {
            assert.ok(owners > 0, 'query buffers must still have an owner'); return height;
        } }), openings, renderedRailSurface: null, isCurrent: guard }, [lease()]);
        inputs.push({ read, owners: () => owners });
        tx.bindRead(read);
        const entry = { ticket: registry.begin({ key: 'ground:read', generation: ++generation }), clear: true,
            isCurrent: tx.isCurrent, commit: tx.commit, rollback: tx.rollback, discard: tx.discard };
        return { tx, read, entry, owners: () => owners };
    }
    return { slot, registry, prepare, close() {
        slot.close(); registry.close();
        for (const source of inputs) { source.read.release(); assert.equal(source.owners(), 0, 'every input owner was released'); }
    } };
}
const clippedArea = read => area(run(read.openings.topologyForClaim(claim).clipTriangleSteps(...triangle)).triangles);

test('registry preflight transfers immutable opening and terrain reads beyond preparation guards', () => {
    const f = fixture(); let sourceLive = true, poison = false;
    const guard = () => { if (poison) throw Error('retired preparation guard was consulted'); return sourceLive; };
    let active;
    try {
        const p = f.prepare(-1, guard);
        const sourceEntry = { ticket: f.registry.begin({ key: 'source', generation: 1 }), clear: true,
            isCurrent: guard, commit() { sourceLive = false; return true; }, rollback() { sourceLive = true; } };
        const batch = f.registry.prepareBatch([sourceEntry, p.entry]);
        assert.equal(batch.publish().status, 'published', 'the final slot must not reject earlier group members own commits');
        assert.equal(p.tx.finalize(), true); p.read.release(); poison = true;
        active = f.slot.capture('curb-builder');
        assert.equal(active.isCurrent(), true); assert.equal(active.currentWithin({})(), true);
        assert.equal(active.terrain.evidenceSceneYAtLocal(0, 0), -1);
        assert.equal(active.openings.isCurrent(), true);
        assert.equal(active.openings.contains(0, 0, 0, claim), true);
        assert.ok(Math.abs(clippedArea(active) - 7) < 1e-8, 'active clipping preserves the independently known area');
        assert.equal(p.owners(), 2, 'one active graph and one consumer share the input');
    } finally { active?.release(); f.close(); }
});

test('a failed successor restores the active identity, opening queries and revision before cleanup', () => {
    const f = fixture(); let old, restored;
    try {
        const first = f.prepare(-1);
        f.registry.prepareBatch([first.entry]).publish(); first.tx.finalize(); first.read.release();
        old = f.slot.capture('old-consumer');
        const next = f.prepare(-2);
        assert.equal(old.isCurrent(), true, 'private preparation leaves the active world usable');
        assert.equal(f.slot.snapshot().pending, 1);
        assert.throws(() => f.registry.prepareBatch([next.entry], { commit() {
            assert.equal(old.isCurrent(), false, 'the successor was committed before the injected failure');
            throw Error('later group member failed');
        } }).publish(), /later group member failed/);
        assert.deepEqual(f.slot.snapshot(), { revision: 1, active: 1, pending: 0, closed: false });
        assert.equal(old.isCurrent(), true);
        assert.equal(old.terrain.evidenceSceneYAtLocal(0, 0), -1);
        assert.ok(Math.abs(clippedArea(old) - 7) < 1e-8);
        restored = f.slot.capture('restored');
        assert.equal(restored.terrain, old.terrain);
        assert.equal(next.owners(), 1, 'only the test source remains after private rollback');
        next.read.release(); assert.equal(next.owners(), 0);
    } finally { old?.release(); restored?.release(); f.close(); }
});

test('success retires old graph validity while a consumer retains its data until release', () => {
    const f = fixture(); let old, active;
    try {
        const first = f.prepare(-1); f.registry.prepareBatch([first.entry]).publish(); first.tx.finalize(); first.read.release();
        old = f.slot.capture('old-consumer');
        const next = f.prepare(-2); f.registry.prepareBatch([next.entry]).publish(); next.tx.finalize(); next.read.release();
        assert.equal(old.isCurrent(), false);
        assert.throws(() => clippedArea(old), { code: 'ground-opening-stale' });
        assert.equal(old.terrain.evidenceSceneYAtLocal(0, 0), -1, 'retirement cannot free another consumers buffers');
        assert.equal(first.owners(), 1); old.release(); old = null; assert.equal(first.owners(), 0);
        active = f.slot.capture('active-consumer');
        assert.equal(active.terrain.evidenceSceneYAtLocal(0, 0), -2);
        assert.equal(active.isCurrent(), true); assert.ok(Math.abs(clippedArea(active) - 7) < 1e-8);
        f.slot.close(); assert.equal(active.isCurrent(), false);
        assert.equal(next.owners(), 1, 'closing the slot preserves a separately retained reader');
        active.release(); active = null; assert.equal(next.owners(), 0);
    } finally { old?.release(); active?.release(); f.close(); }
});

test('busy, cancellation and close before finalization release both graph generations', () => {
    const f = fixture();
    try {
        const cancelled = f.prepare(-1);
        assert.throws(() => f.slot.begin({ isCurrent: () => true }), { code: 'ground-dependency-busy' });
        assert.equal(cancelled.tx.discard(), true); assert.equal(cancelled.tx.discard(), false);
        cancelled.read.release(); assert.equal(cancelled.owners(), 0);
        assert.deepEqual(f.slot.snapshot(), { revision: 0, active: 0, pending: 0, closed: false });
        const first = f.prepare(-2); f.registry.prepareBatch([first.entry]).publish(); first.tx.finalize(); first.read.release();
        const next = f.prepare(-3); f.registry.prepareBatch([next.entry]).publish(); next.read.release();
        f.slot.close(); assert.equal(first.owners(), 0); assert.equal(next.owners(), 0);
        assert.equal(f.slot.hasActive(), false); assert.equal(f.slot.capture('closed'), null);
        assert.deepEqual(f.slot.snapshot(), { revision: 2, active: 0, pending: 0, closed: true });
    } finally { f.close(); }
});
