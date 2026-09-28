// Real source planning/cache/publication with a controlled GPU completion seam.
// Native pixel and upload acceptance is recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldGroundPaint } from '../world/ground-paint.js';
import { createGroundPaintCache } from '../core/ground-paint-cache.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { compileSurfaceClaim } from '../core/surface-hierarchy.js';
import { captureGroundPaintMaterialRows } from '../core/ground-paint-styles.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';

function fixture({ draws = 8 } = {}) {
    const drawLimit = draws;
    let frame = 0, drawCount = 0;
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const painter = { createTask({ packet, targetLease }) {
        let transferred = false, disposed = false;
        return { async prepare() {}, step() { drawCount++; return true; },
            result() {
                transferred = true;
                return { receiver: packet.receiver, bounds: packet.bounds, size: packet.size,
                    styles: packet.styles, target: targetLease.target, layer: targetLease.layer,
                    patterns: { ready: true, released: false, texture: null },
                    copyMaterialRows: () => captureGroundPaintMaterialRows(packet.styles, null, packet.bounds),
                    get disposed() { return disposed; },
                    dispose() { if (!disposed) { disposed = true; targetLease.release(); } } };
            },
            dispose() { if (!transferred && !disposed) { disposed = true; targetLease.release(); } },
        };
    }, dispose() {} };
    const paint = createWorldGroundPaint({ renderer: { domElement: new EventTarget() }, registry, boundary,
        cacheFactory: options => createGroundPaintCache({ ...options, size: 8, widthsM: [16, 64, 256], blockSize: 2,
            maxTextureBytes: 256, packetLimits: { pixels: 64, draws: drawLimit, verticesPerPolygon: 20 }, painter,
            queue: { enqueue() { throw new Error('Source work escaped its coordinator'); }, dispose() {} },
            frameSequence: () => frame }) });
    paint.registerStyle('pavers', { id: 1, revision: 'm1', surfaceClass: 'sidewalk', roughness: .9,
        metalness: 0, normalInfluence: 0, linearColor: [.5, .5, .5] });
    function record(key, x, revision = 's1') {
        const ring = Object.freeze([[x - 2, -2], [x + 2, -2], [x + 2, 2], [x - 2, 2]]
            .map(([x, z]) => Object.freeze({ x, z })));
        return Object.freeze({ key, sourceRevision: revision, materialKey: 'pavers', materialRevision: 'm1',
            receiver: paint.receiver, claim: compileSurfaceClaim({ surfaceClass: 'sidewalk', ownerId: key,
                coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' }),
            polygons: Object.freeze([Object.freeze({ outerRing: ring, holeRings: Object.freeze([]) })]) });
    }
    async function prepare(steps, inspect = () => {}) {
        try {
            for (let i = 0; i < 5000; i++) {
                frame++; const next = steps.next(); inspect(next);
                if (next.done) return next.value;
                await Promise.resolve(); await Promise.resolve();
            }
            assert.fail('Paint source preparation did not converge');
        } finally { steps.return(); }
    }
    function publish(candidate, { first = null, fail = false } = {}) {
        assert.ok(candidate);
        const batch = registry.prepareBatch([...(first ? [{ ticket: registry.begin({ key: 'upstream', generation: ++frame }), ...first }] : []), candidate.entry], {
            commit() { if (fail) throw new Error('late receiver failure'); },
        });
        assert.equal(batch.publish().status, 'published');
        assert.equal(candidate.finalize(), true);
    }
    return { paint, record, prepare, publish, registry, draws: () => drawCount,
        close() { paint.dispose(); boundary.close(); } };
}
const replacements = rows => Object.freeze(rows.map(([bucketKey, owner, records]) => Object.freeze({ bucketKey, owner, records: records === null ? null : Object.freeze([records]) })));

test('identical recompiled owners retain their plan and never allocate or repaint a successor page', async () => {
    const f = fixture();
    try {
        f.publish(await f.prepare(f.paint.prepareReplacementsSteps(replacements([
            ['region', 'owner', f.record('road', 0)],
        ]), () => true)));
        const original = f.paint.sourceAt(0, 0), before = f.paint.snapshot(), draws = f.draws();
        const candidate = await f.prepare(f.paint.prepareReplacementsSteps(replacements([
            ['region', 'owner', f.record('road', 0)],
        ]), () => true));
        f.publish(candidate);
        assert.equal(f.paint.sourceAt(0, 0), original, 'no polygon or query index is rebuilt');
        assert.equal(f.paint.snapshot().sourceRevision, before.sourceRevision);
        assert.equal(f.draws(), draws);
        assert.equal(f.paint.snapshot().sourcePreparation.reusedOwners, before.sourcePreparation.reusedOwners + 1);
        // Identical records in a different region still move ownership.
        f.publish(await f.prepare(f.paint.prepareReplacementsSteps(replacements([
            ['region', 'owner', null], ['moved', 'owner', f.record('road', 0)],
        ]), () => true)));
        assert.equal(f.paint.sourceAt(0, 0), original);
        f.paint.stage('moved', 'owner', null);
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['moved'], () => true)));
        assert.equal(f.paint.sourceAt(0, 0), null);
    } finally { f.close(); }
});

test('a no-op candidate still rejects a source edit before publication', async () => {
    const f = fixture();
    try {
        const initial = replacements([['region', 'owner', f.record('road', 0)]]);
        f.publish(await f.prepare(f.paint.prepareReplacementsSteps(initial, () => true)));
        const candidate = await f.prepare(f.paint.prepareReplacementsSteps(initial, () => true));
        f.paint.stage('region', 'owner', Object.freeze([f.record('road', 20, 's2')]));
        assert.equal(candidate.entry.isCurrent(), false);
        candidate.discard();
        assert.equal(f.paint.sourceAt(0, 0).key, 'road');
        assert.equal(f.paint.sourceAt(20, 0), null);
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        assert.equal(f.paint.sourceAt(0, 0), null);
        assert.equal(f.paint.sourceAt(20, 0).key, 'road');
    } finally { f.close(); }
});

test('candidate paint owners and coarse mapping roll back with a later receiver and retry without leaking desired sources', async () => {
    const f = fixture();
    try {
        const old = f.record('square', 0), next = f.record('square', 20, 's2');
        f.paint.stage('old', 'square', Object.freeze([old]));
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['old'], () => true)));
        const revision = f.paint.snapshot().sourceRevision;
        const oldMapping = f.paint.snapshot().pages[2].layer;
        const rows = replacements([['old', 'square', null], ['next', 'square', next]]);
        const inspectOld = () => {
            assert.equal(f.paint.sourceAt(0, 0)?.key, 'square'); assert.equal(f.paint.sourceAt(20, 0), null);
            assert.equal(f.paint.paintAt(0, 0).record.key, 'square');
            assert.equal(f.paint.snapshot().sourceRevision, revision);
            assert.equal(f.paint.snapshot().pages[2].layer, oldMapping);
        };
        const rejected = await f.prepare(f.paint.prepareReplacementsSteps(rows, () => true), inspectOld);
        assert.throws(() => f.publish(rejected, { fail: true }), /late receiver failure/);
        inspectOld();
        // A normal producer must still see its old source table after failure.
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['old', 'next'], () => true)));
        inspectOld();
        let sourceCurrent = true;
        const accepted = await f.prepare(f.paint.prepareReplacementsSteps(rows, () => sourceCurrent), inspectOld);
        f.publish(accepted, { first: { clear: true, isCurrent: () => sourceCurrent,
            commit() { sourceCurrent = false; return true; }, rollback() { sourceCurrent = true; }, discard() {} } });
        assert.equal(f.paint.sourceAt(0, 0), null); assert.equal(f.paint.sourceAt(20, 0).key, 'square');
        assert.equal(f.paint.paintAt(20, 0).record.key, 'square');
        assert.equal(f.paint.snapshot().sourceRegions, 1);
        // A later ordinary owner removal addresses the committed new region.
        f.paint.stage('next', 'square', null);
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['next'], () => true)));
        assert.equal(f.paint.sourceAt(20, 0), null); assert.equal(f.paint.snapshot().sourceRecords, 0);
    } finally { f.close(); }
});

test('a paint source edit during detached preparation rejects the candidate and retains the actual new obligation', async () => {
    const f = fixture();
    try {
        const old = f.record('square', 0);
        f.paint.stage('region', 'square', Object.freeze([old]));
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        const steps = f.paint.prepareReplacementsSteps(replacements([['region', 'square', f.record('square', 20, 'candidate')]]), () => true);
        assert.equal(steps.next().done, false);
        f.paint.stage('region', 'square', Object.freeze([f.record('square', 40, 'streamed')]));
        assert.equal(await f.prepare(steps), null);
        assert.equal(f.paint.sourceAt(0, 0).key, 'square'); assert.equal(f.paint.sourceAt(20, 0), null);
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        assert.equal(f.paint.sourceAt(40, 0).key, 'square'); assert.equal(f.paint.sourceAt(20, 0), null);
        const cancelled = f.paint.prepareReplacementsSteps(replacements([['region', 'square', old]]), () => true);
        assert.equal(cancelled.next().done, false); cancelled.return();
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        assert.equal(f.paint.sourceAt(40, 0).key, 'square');
    } finally { f.close(); }
});

test('paint candidate ownership admission rejects duplicate, mutable and oversized replacements before allocating a page', () => {
    const f = fixture();
    try {
        const row = ['region', 'square', f.record('square', 0)];
        assert.throws(() => f.paint.prepareReplacementsSteps(replacements([row, row]), () => true).next(), /Duplicate/);
        assert.throws(() => f.paint.prepareReplacementsSteps([row], () => true).next(), /captured/);
        const steps = f.paint.prepareReplacementsSteps(replacements(Array.from({ length: GROUND_GENERATION_LIMITS.paintSources.maxChangedRegions + 1 }, (_, i) =>
            [`region-${i}`, 'square', row[2]])), () => true);
        assert.throws(() => { while (!steps.next().done) {} }, error =>
            error.code === 'ground-generation-capacity' && /region capacity/.test(error.message));
        assert.equal(f.draws(), 0); assert.equal(f.paint.snapshot().sourceRecords, 0);
    } finally { f.close(); }
});

test('a complete forty-region receiver update publishes all paint together and rolls back a late failure', async () => {
    const f = fixture({ draws: 64 });
    try {
        const old = f.record('old', -10);
        f.paint.stage('old-region', 'old', Object.freeze([old]));
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['old-region'], () => true)));
        const oldRevision = f.paint.snapshot().sourceRevision;
        const rows = replacements(Array.from({ length: 40 }, (_, i) =>
            [`region-${i}`, `owner-${i}`, f.record(`owner-${i}`, i * 5)]));
        let visits = 0;
        const inspect = () => {
            visits++;
            assert.equal(f.paint.snapshot().sourceRevision, oldRevision);
            assert.equal(f.paint.sourceAt(-10, 0)?.key, 'old');
            assert.equal(f.paint.sourceAt(195, 0), null);
        };
        const rejected = await f.prepare(f.paint.prepareReplacementsSteps(rows, () => true), inspect);
        assert.ok(visits > 40, 'the complete source batch is cooperatively prepared');
        assert.throws(() => f.publish(rejected, { fail: true }), /late receiver failure/);
        inspect();
        const candidate = await f.prepare(f.paint.prepareReplacementsSteps(rows, () => true), inspect);
        f.publish(candidate);
        for (let i = 0; i < 40; i++) assert.equal(f.paint.sourceAt(i * 5, 0)?.key, `owner-${i}`);
        assert.equal(f.paint.snapshot().sourceRegions, 41);
        assert.equal(f.paint.snapshot().sourceRecords, 41);
    } finally { f.close(); }
});

test('moving every admitted paint source between regions counts old and new without raising live or GPU limits', async () => {
    const f = fixture();
    try {
        const count = GROUND_GENERATION_LIMITS.paintSources.maxRegions;
        const records = Array.from({ length: count }, (_, i) => f.record(`owner-${i}`, 10000 + i * 5));
        const initial = records.map((record, i) => [`old-${i}`, `owner-${i}`, record]);
        f.publish(await f.prepare(f.paint.prepareReplacementsSteps(replacements(initial), () => true)));
        const before = f.paint.snapshot(), drawCount = f.draws();
        const moved = records.flatMap((record, i) => [[`old-${i}`, `owner-${i}`, null], [`new-${i}`, `owner-${i}`, record]]);
        f.publish(await f.prepare(f.paint.prepareReplacementsSteps(replacements(moved), () => true)));
        assert.equal(f.paint.snapshot().sourceRegions, count);
        assert.equal(f.paint.snapshot().sourceRecords, count);
        assert.equal(f.paint.snapshot().sourceRevision, before.sourceRevision);
        assert.equal(f.draws(), drawCount, 'changing only regional ownership does not redraw colour');
        assert.equal(f.paint.sourceAt(10000, 0)?.key, 'owner-0');
        assert.equal(f.paint.sourceAt(10000 + (count - 1) * 5, 0)?.key, `owner-${count - 1}`);
        const excessive = f.paint.prepareReplacementsSteps(replacements([['extra', 'extra', f.record('extra', 20000)]]), () => true);
        await assert.rejects(f.prepare(excessive), error => error.code === 'ground-generation-capacity');
        assert.equal(f.paint.snapshot().sourceRegions, count);
        assert.equal(f.paint.sourceAt(20000, 0), null);
    } finally { f.close(); }
});

test('one owner publishes and removes multiple paint contributions atomically', async () => {
    const f = fixture();
    try {
        const first = f.record('base', 0), second = f.record('cycle', 20);
        f.paint.stage('region', 'road-owner', Object.freeze([first, second]));
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        assert.equal(f.paint.snapshot().sourceRecords, 2);
        assert.equal(f.paint.sourceAt(0, 0)?.key, 'base');
        assert.equal(f.paint.sourceAt(20, 0)?.key, 'cycle');

        let current = true;
        const cancelled = f.paint.prepareReplacementsSteps(
            Object.freeze([Object.freeze({ bucketKey: 'region', owner: 'road-owner', records: Object.freeze([second]) })]),
            () => current,
        );
        assert.equal(cancelled.next().done, false);
        current = false;
        cancelled.return();
        assert.equal(f.paint.snapshot().sourceRecords, 2, 'cancelled replacement keeps both contributions');

        f.paint.stage('region', 'road-owner', null);
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        assert.equal(f.paint.snapshot().sourceRecords, 0);
        assert.equal(f.paint.sourceAt(0, 0), null);
        assert.equal(f.paint.sourceAt(20, 0), null);
    } finally { f.close(); }
});

test('per-owner record arrays are bounded and remain immutable', () => {
    const f = fixture();
    try {
        const records = Object.freeze(Array.from({ length: 9 }, (_, i) => f.record(`record-${i}`, i * 4)));
        assert.throws(() => f.paint.stage('region', 'owner', records), /owner record capacity/);
        const mutable = [f.record('mutable', 0)];
        assert.throws(() => f.paint.stage('region', 'owner', mutable), /immutable/);
        assert.throws(() => f.paint.prepareReplacementsSteps(
            Object.freeze([Object.freeze({ bucketKey: 'region', owner: 'owner', records: mutable })]),
            () => true,
        ).next(), /immutable/);
        assert.throws(() => f.paint.stage('region', 'owner', []), /record/);
        assert.throws(() => f.paint.prepareReplacementsSteps(
            Object.freeze([Object.freeze({ bucketKey: 'region', owner: 'owner', records: Object.freeze([]) })]),
            () => true,
        ).next(), /record/);
        assert.equal(f.paint.snapshot().sourceRecords, 0);
    } finally { f.close(); }
});

test('staging the same frozen owner array is a no-op for an in-flight candidate', async () => {
    const f = fixture();
    try {
        const records = Object.freeze([f.record('same-owner', 0)]);
        f.paint.stage('region', 'owner', records);
        const candidate = f.paint.prepareBucketsSteps(['region'], () => true);
        assert.equal(candidate.next().done, false);
        f.paint.stage('region', 'owner', records);
        const prepared = await f.prepare(candidate);
        assert.ok(prepared, 'identical staging leaves the captured candidate current');
        f.publish(prepared);
        assert.equal(f.paint.sourceAt(0, 0)?.key, 'same-owner');
    } finally { f.close(); }
});

test('flattened record capacity rejects an aggregate without changing the published source', async () => {
    const f = fixture({ draws: 64 });
    try {
        const old = f.record('old', 0);
        f.paint.stage('region', 'old', Object.freeze([old]));
        f.publish(await f.prepare(f.paint.prepareBucketsSteps(['region'], () => true)));
        const rows = Object.freeze(Array.from({ length: 257 }, (_, ownerIndex) => {
            const records = Object.freeze(Array.from({ length: 8 }, (_, recordIndex) =>
                f.record(`owner-${ownerIndex}-${recordIndex}`, 100 + ownerIndex * 10 + recordIndex)));
            return Object.freeze({ bucketKey: 'region', owner: `owner-${ownerIndex}`, records });
        }));
        await assert.rejects(f.prepare(f.paint.prepareReplacementsSteps(rows, () => true)), error =>
            error.code === 'ground-generation-capacity' && /region record capacity/.test(error.message));
        assert.equal(f.paint.sourceAt(0, 0)?.key, 'old');
        assert.equal(f.paint.snapshot().sourceRecords, 1);
    } finally { f.close(); }
});

test('independent source candidates serialize and preserve both producers', async () => {
    const f = fixture();
    try {
        const a = f.record('producer-a', 0), b = f.record('producer-b', 20);
        f.paint.stage('a', 'owner-a', Object.freeze([a]));
        f.paint.stage('b', 'owner-b', Object.freeze([b]));
        const candidateA = await f.prepare(f.paint.prepareBucketsSteps(['a'], () => true));
        const stepsB = f.paint.prepareBucketsSteps(['b'], () => true);
        let waiting;
        for (let i = 0; i < 20; i++) {
            waiting = stepsB.next();
            if (waiting.value?.phase === 'paint-source-owner-slot') break;
        }
        assert.equal(waiting?.value?.phase, 'paint-source-owner-slot');
        assert.equal(f.paint.sourceAt(0, 0), null, 'prepared A is not visible before publication');
        f.publish(candidateA);
        const candidateB = await f.prepare(stepsB);
        f.publish(candidateB);
        assert.equal(f.paint.sourceAt(0, 0)?.key, 'producer-a');
        assert.equal(f.paint.sourceAt(20, 0)?.key, 'producer-b');
        assert.equal(f.paint.paintAt(0, 0).record.key, 'producer-a');
        assert.equal(f.paint.paintAt(20, 0).record.key, 'producer-b');
    } finally { f.close(); }
});

test('discarding a prepared source candidate releases the turn without leaking it', async () => {
    const f = fixture();
    try {
        const a = f.record('discarded', 0), b = f.record('survivor', 20);
        f.paint.stage('a', 'owner-a', Object.freeze([a]));
        f.paint.stage('b', 'owner-b', Object.freeze([b]));
        const candidateA = await f.prepare(f.paint.prepareBucketsSteps(['a'], () => true));
        const stepsB = f.paint.prepareBucketsSteps(['b'], () => true);
        let waiting;
        for (let i = 0; i < 20; i++) {
            waiting = stepsB.next();
            if (waiting.value?.phase === 'paint-source-owner-slot') break;
        }
        assert.equal(waiting?.value?.phase, 'paint-source-owner-slot');
        assert.equal(candidateA.discard(), true);
        const candidateB = await f.prepare(stepsB);
        f.publish(candidateB);
        assert.equal(f.paint.sourceAt(0, 0), null);
        assert.equal(f.paint.sourceAt(20, 0)?.key, 'survivor');
    } finally { f.close(); }
});
