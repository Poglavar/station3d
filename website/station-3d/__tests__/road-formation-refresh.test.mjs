import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function refreshPublishedFormationSurfaces('), source.indexOf('function cancelSurfaceAlignmentRefresh('));
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    let time = 0;
    const requests = [], visits = [], errors = [];
    const model = { revision: 1, surfaceGeometryRevision: 1, hasPendingBuild: () => false };
    const pending = new Set(['a', 'b']);
    const features = new Map(['a', 'b'].map(key => [key, [{ key }]]));
    const context = vm.createContext({
        roadFormationModel: model, observedFormationGeometryRevision: 1,
        performance: { now: () => time }, console: { error: (...args) => errors.push(args) },
        formationPreparationFailure: null, formationPreparationJob: null, FORMATION_RETRY_MS: 2000,
        formationSurfaceRetryAt: new Map(), pendingFormationSurfaceTiles: pending,
        tileFeatures: features, tileRegistrationJobs: new Map(),
        tileBuildJobs: { has(key) { visits.push(key); return key === 'a'; } },
        roadSurfaceUsesEngineeredFormation: () => true, roadFeatureKey: feature => feature.key,
        roadFeatureSources: { selected: key => ({ feature: { key } }) },
        roadEntries: new Map(), roadFeatureFormationGeneration: () => 1,
        enqueueTileRoads: key => { requests.push(key); return Promise.reject(new Error('injected tile failure')); },
        roadFormationSurfaceTiles: { tileKeysForOsmIds: () => ['b'] },
        FRAME_CHUNK_REPEAT_ITEM: 'more',
    });
    vm.runInContext(code, context);
    return { context, model, pending, requests, visits, errors, time: value => { time = value; } };
}

test('a blocked first tile cannot cause a whole pending-list scan or starve the next tile', async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) f.pending.add(`far:${i}`);
    f.context.refreshPublishedFormationSurfaces();
    assert.deepEqual(f.visits, ['a']); assert.deepEqual(f.requests, []);
    f.context.refreshPublishedFormationSurfaces();
    assert.deepEqual(f.visits, ['a', 'b']); assert.deepEqual(f.requests, ['b']);
    await settle();
    assert.equal(f.pending.has('b'), true, 'failure retains the publication obligation');
});

test('failed tile rebuilds back off, while a new completed formation revision can retry immediately', async () => {
    const f = fixture(); f.pending.delete('a');
    f.context.refreshPublishedFormationSurfaces(); await settle();
    f.time(1999); f.context.refreshPublishedFormationSurfaces();
    assert.deepEqual(f.requests, ['b']);
    f.time(2000); f.context.refreshPublishedFormationSurfaces(); await settle();
    assert.deepEqual(f.requests, ['b', 'b']);
    f.model.surfaceGeometryRevision = 2;
    f.model.getSurfaceGeometryChangesSince = () => ({ revision: 2, osmIds: [1], full: false });
    f.time(2001); f.context.refreshPublishedFormationSurfaces(); await settle();
    assert.deepEqual(f.requests, ['b', 'b', 'b']);
});

test('a late failure from a previous session cannot requeue or delay a new session tile', async () => {
    const f = fixture(); f.pending.delete('a');
    let reject;
    f.context.enqueueTileRoads = key => { f.requests.push(key); return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); };
    f.context.refreshPublishedFormationSurfaces();
    f.context.roadFormationModel = { ...f.model };
    reject(new Error('old session completed late')); await settle();
    assert.equal(f.pending.has('b'), false);
    assert.equal(f.context.formationSurfaceRetryAt.size, 0);
    assert.equal(f.errors.length, 0);
});

test('formation preparation failures are bounded and new input bypasses the old retry delay', async () => {
    const f = fixture(); f.pending.clear();
    f.model.hasPendingBuild = () => true;
    let jobs = 0;
    f.context.buildQueue = { enqueue(_items, _step, options) {
        jobs++;
        const job = { cancelled: false, promise: Promise.reject(new Error('injected formation failure')) };
        job.promise.catch(() => options.onError());
        return job;
    } };
    f.context.refreshPublishedFormationSurfaces(); await settle();
    assert.equal(jobs, 1);
    f.time(1999); f.context.refreshPublishedFormationSurfaces(); assert.equal(jobs, 1);
    f.model.revision++;
    f.context.refreshPublishedFormationSurfaces(); await settle(); assert.equal(jobs, 2);
    f.time(3999); f.context.refreshPublishedFormationSurfaces(); await settle(); assert.equal(jobs, 3);
});
