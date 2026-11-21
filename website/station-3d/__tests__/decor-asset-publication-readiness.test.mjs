// Exercise the real asynchronous producer through controlled fetch/build waits
// and publication outcomes, including stale completions and rejected swaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDecorAssetReadiness } from '../core/decor-asset-readiness.js';

const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadAsset(');
const end = source.indexOf('// Fetch one decor kind', start);
assert.ok(start >= 0 && end > start);
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function harness() {
    const readiness = createDecorAssetReadiness(['greenery']);
    const published = [], disposed = [], warnings = [];
    let requestId = 1, terrainCurrent = true, outcome = 'published', terrainWaits = 0;
    const runtime = vm.createContext({
        decorActivityCount: 0, groundPaint: null, greeneryGroup: null, paintVisibilityRevision: 0,
        decorAssetReadiness: readiness, isDecorRequestStale: id => id !== requestId,
        decorTerrainGenerationIsCurrent: () => terrainCurrent,
        awaitDecorTerrain: () => { terrainWaits++; },
        prewarmDetachedObject: function* () {},
        replaceGroup: (_prop, group) => {
            assert.equal(readiness.snapshot().pending, 1, 'publication must precede success');
            if (outcome === 'published') published.push(group);
            return { status: outcome };
        },
        disposeGroup: group => disposed.push(group), disposeGreeneryGroup: group => disposed.push(group),
        renderer: {}, camera: {}, scene: {}, nowMs: () => 0, reportOutOfLoopWork() {},
        nextAnimationFrame: async () => {}, console: { warn: (...args) => warnings.push(args) },
    });
    vm.runInContext(source.slice(start, end), runtime);
    return {
        readiness, published, disposed, warnings,
        waits: () => terrainWaits,
        setTerrain: value => { terrainCurrent = value; },
        setOutcome: value => { outcome = value; },
        advance: () => { requestId++; },
        run: (fetch = async () => ({}), build = async () => ({ name: 'candidate' })) =>
            runtime.loadAsset(requestId, { centerLat: 45, centerLon: 16 }, 'test-greenery', 'greenery', fetch, build),
    };
}

test('decor remains pending throughout fetch and construction and settles after publication', async () => {
    const h = harness(), fetchGate = deferred(), buildGate = deferred(), started = deferred();
    const task = h.run(() => fetchGate.promise, () => { started.resolve(); return buildGate.promise; });
    assert.equal(h.readiness.snapshot().pending, 1);
    assert.equal(h.published.length, 0);
    fetchGate.resolve({});
    await started.promise;
    assert.equal(h.readiness.snapshot().pending, 1);
    assert.equal(h.published.length, 0);
    const group = { name: 'finished' }; buildGate.resolve(group);
    await task;
    assert.deepEqual(h.published, [group]);
    assert.equal(h.readiness.snapshot().published, 1);
    assert.equal(h.readiness.snapshot().pending, 0);
});

test('an empty successful source is complete; actual fetch/build/publication failures remain visible', async () => {
    const empty = harness(); await empty.run(async () => null);
    assert.equal(empty.readiness.snapshot().empty, 1);
    for (const stage of ['fetch', 'build', 'publication']) {
        const h = harness();
        if (stage === 'publication') h.setOutcome('rejected');
        await h.run(async () => { if (stage === 'fetch') throw new Error(stage); return {}; },
            async () => { if (stage === 'build') throw new Error(stage); return {}; });
        assert.equal(h.readiness.snapshot().failed, 1, stage);
        assert.equal(h.readiness.snapshot().published, 0, stage);
        assert.equal(h.published.length, 0, stage);
        assert.equal(h.warnings.length, 1, stage);
    }
});

test('terrain changing during construction withholds the result and keeps the refresh outstanding', async () => {
    const h = harness(), buildGate = deferred(), started = deferred();
    const task = h.run(undefined, (_index, shouldCancel) => {
        started.resolve(shouldCancel); return buildGate.promise;
    });
    const shouldCancel = await started.promise;
    h.setTerrain(false);
    assert.equal(shouldCancel(), true);
    const group = {}; buildGate.resolve(group); await task;
    assert.deepEqual(h.disposed, [group]);
    assert.equal(h.published.length, 0);
    assert.equal(h.readiness.snapshot().pending, 1);
    assert.equal(h.waits(), 1);
});

test('an older in-flight request cannot publish over or complete its successor', async () => {
    const h = harness(), buildGate = deferred(), started = deferred();
    const old = h.run(undefined, () => { started.resolve(); return buildGate.promise; });
    await started.promise;
    h.advance();
    const currentGroup = { name: 'current' };
    await h.run(undefined, async () => currentGroup);
    const oldGroup = { name: 'old' }; buildGate.resolve(oldGroup); await old;
    assert.deepEqual(h.published, [currentGroup]);
    assert.deepEqual(h.disposed, [oldGroup]);
    assert.equal(h.readiness.snapshot().published, 1);
    assert.equal(h.readiness.snapshot().failed, 0);
});

test('a compiler throwing after a receiver change requests refresh instead of latching a producer failure', async () => {
    const h = harness(), buildGate = deferred(), started = deferred();
    const task = h.run(undefined, () => { started.resolve(); return buildGate.promise; });
    await started.promise;
    h.setTerrain(false);
    buildGate.reject(Object.assign(new Error('Detail receiver generation changed'), { code: 'ground-generation-stale' }));
    await task;
    assert.equal(h.published.length, 0);
    assert.equal(h.readiness.snapshot().pending, 1);
    assert.equal(h.readiness.snapshot().failed, 0);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.waits(), 1);
    h.setTerrain(true);
    await h.run();
    assert.equal(h.readiness.snapshot().published, 1);
    assert.equal(h.readiness.snapshot().pending, 0);
});
