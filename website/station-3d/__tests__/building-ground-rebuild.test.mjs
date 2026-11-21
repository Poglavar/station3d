import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createBuildingGroundDependencyCache } from '../core/building-ground-dependencies.js';
import { takeNextTileRebuild } from '../core/regional-tile-rebuild.js';
import { composeFoundationGroundSampler, buildFoundationSkirtPositionsCooperative } from '../core/foundation-skirt.js';
import {
    foundationFormationWaitAllowanceMs, pendingRoadFormationChangeTouches, roadFormationWaitExpired,
} from '../core/road-formation-dependency.js';

// Exercise the real world adapter without constructing a renderer or scene.
const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
const adapter = source.slice(source.indexOf('function checkTerrainBuildingDependencies('),
    source.indexOf('// One tile per frame keeps a border crossing'));
const samplers = source.slice(source.indexOf('function createBuildingFoundationGroundSampler('),
    source.indexOf('function createFoundationSkirtMesh('));
// The shared formation wait clock, keyed on the published generation.
const waitClock = source.slice(source.indexOf('let formationWaitPublishedRevision'),
    source.indexOf('\n}\n', source.indexOf('function formationWaitStartMs(')) + 3);

function fixture({ tracked = true, samples = 4, formationChanges = null } = {}) {
    const jobs = [], replacements = [];
    let clock = 0;
    const dependencies = createBuildingGroundDependencyCache({ checksPerStep: 1 });
    if (tracked) {
        const capture = dependencies.begin('0_0');
        for (let x = 0; x < samples; x++) capture.record(0, 10, x, 0, 2);
        capture.seal();
    }
    const payload = { features: [], streetFacingFeatures: [] };
    let y = 2, pendingRoad = false;
    const terrain = {
        revision: 1,
        evidenceSceneYAtLocal: () => y,
        roadFormation: { revision: 1, hasPendingBuild: () => pendingRoad, sceneYAtLocal: () => null,
            ...(formationChanges ? { surfaceGeometrySourceRevision: 1, getChangesSince: () => formationChanges } : {}) },
        railFormation: { revision: 1, hasPendingBuild: () => false, sceneYAtLocal: () => null },
    };
    const context = vm.createContext({
        terrainReference: terrain,
        terrainBuildingRebuildCheck: null,
        terrainBuildingRebuildQueue: [{ tileKey: '0_0', payload }],
        streamedBuildingTiles: new Map([['0_0', payload]]),
        tileVisualReplacements: new Map(), tileBuildJobs: new Map(),
        buildingGroundDependencies: dependencies,
        MAX_ACTIVE_BUILDING_REPLACEMENTS: 2, DETAILED_BUILDING_TILE_M: 100,
        currentBuildLocalX: 0, currentBuildLocalZ: 0,
        takeNextTileRebuild, composeFoundationGroundSampler, buildFoundationSkirtPositionsCooperative,
        FRAME_CHUNK_REPEAT_ITEM: 'repeat', FRAME_CHUNK_WAIT_ITEM: 'wait',
        tileBuildPriority: () => 1,
        advanceBuildingRoadFormationDependency: () => 'defer',
        performance: { now: () => clock },
        FOUNDATION_FORMATION_REACH_M: 24,
        tileLocalBounds: (tx, tz, size) => ({ minX: tx * size, minZ: tz * size, maxX: (tx + 1) * size, maxZ: (tz + 1) * size }),
        pendingRoadFormationChangeTouches, roadFormationWaitExpired, foundationFormationWaitAllowanceMs,
        getFrameChunkWorkMotionState: () => 'stationary',
        beginTileVisualReplacement: key => { replacements.push(key); return true; },
        enqueueTileFeatures: () => {},
        buildQueue: {
            enqueue(items, advance, options) {
                const job = { items, advance, options };
                jobs.push(job);
                return job;
            },
        },
    });
    vm.runInContext(waitClock + '\n' + samplers + '\n' + adapter, context);
    const drain = () => vm.runInContext('drainTerrainBuildingRebuild()', context);
    function step() {
        const job = jobs[0];
        assert.ok(job, 'the adapter must submit checks through the bounded building queue');
        const outcome = job.advance(job.items[0]);
        if (outcome === undefined) { jobs.shift(); job.options.onComplete(); }
        return outcome;
    }
    function finish() {
        for (let i = 0; jobs.length && i < 50; i++) assert.notEqual(step(), 'wait');
        assert.equal(jobs.length, 0);
    }
    return { context, terrain, payload, dependencies, replacements, jobs, drain, step, finish,
        setHeight: next => { y = next; }, setPendingRoad: value => { pendingRoad = value; },
        setClock: next => { clock = next; } };
}

test('a terrain publication with identical foundation inputs retains the existing tile', () => {
    const f = fixture();
    f.terrain.revision++;
    assert.equal(f.drain(), true);
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 0);
    assert.ok(f.context.terrainBuildingRebuildCheck, 'in-flight validation remains a world-drain obligation');
    assert.deepEqual(f.replacements, []);
    f.finish();
    assert.equal(f.context.terrainBuildingRebuildCheck, null);
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 0);
    assert.equal(f.dependencies.snapshot().retainedChecks, 1);
    assert.deepEqual(f.replacements, []);
});

test('the actual world skirt records both ground and an initially absent tunnel roof', () => {
    const f = fixture({ tracked: false });
    const capture = f.dependencies.begin('0_0');
    f.context.capture = capture;
    vm.runInContext(`
        const segments = [
            { ax: 0, az: 0, bx: 4, bz: 0 },
            { ax: 4, az: 0, bx: 4, bz: 4 },
            { ax: 4, az: 4, bx: 0, bz: 0 },
        ];
        const skirt = createFoundationSkirtPositionsIterator(segments, 10, capture);
        while (!skirt.next().done) {}
        capture.seal();
    `, f.context);
    assert.ok(f.dependencies.snapshot().bytes > 0);
    f.terrain.railFormation.tunnelRoofInfoAt = () => ({ ceilingY: 8 });
    f.drain(); f.finish(); f.drain();
    assert.deepEqual(f.replacements, ['0_0'], 'adding a structural floor invalidates the surveyed foundation');
    const stage = source.slice(source.indexOf('function* stageBuildingFeatureGdi('),
        source.indexOf('function createGdiBuildingBuildTask('));
    assert.match(stage, /createFoundationSkirtPositionsIterator\(\s*foundationSegments,\s*foundationLiftY,\s*buildContext\?\.groundDependencies,/,
        'the survey transaction must supply the tile recorder to the real sampler');
});

test('a changed foundation enters the existing complete replacement path', () => {
    const f = fixture();
    f.setHeight(2.001);
    f.drain(); f.finish();
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 1);
    assert.deepEqual(f.replacements, [], 'validation does not detach or replace visible meshes');
    f.drain();
    assert.deepEqual(f.replacements, ['0_0']);
    assert.equal(f.jobs.length, 0, 'the differing input needs no second validation');
});

test('a publication between check slices rechecks and cannot retire the new obligation', () => {
    const f = fixture();
    f.drain(); assert.equal(f.step(), 'repeat');
    f.terrain.revision++;
    f.context.terrainBuildingRebuildQueue.push({ tileKey: '0_0', payload: f.payload });
    f.finish();
    assert.equal(f.dependencies.snapshot().retainedChecks, 0);
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 1);
    f.setHeight(3);
    f.drain(); f.finish(); f.drain();
    assert.deepEqual(f.replacements, ['0_0']);
});

test('initial construction and pending road work finish before validation can query them', () => {
    const f = fixture();
    f.context.tileBuildJobs.set('0_0', {});
    assert.equal(f.drain(), false);
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 1);
    assert.equal(f.jobs.length, 0);
    f.context.tileBuildJobs.delete('0_0');
    f.drain(); f.setPendingRoad(true);
    assert.equal(f.step(), 'wait');
    assert.equal(f.dependencies.snapshot().retainedChecks, 0);
    f.setPendingRoad(false); f.finish();
    assert.deepEqual(f.replacements, []);
});

test('a pending formation change holds a re-check only for the gate allowance, and only when it reaches the tile', () => {
    const near = fixture();
    near.drain(); near.setPendingRoad(true);
    assert.equal(near.step(), 'wait', 'a change of unknown reach is assumed to touch the tile');
    near.setClock(1999);
    assert.equal(near.step(), 'wait', 'the stationary allowance is two seconds');
    near.setClock(2001);
    assert.notEqual(near.step(), 'wait', 'an expired wait proceeds against the published ground');
    near.finish();
    assert.deepEqual(near.replacements, []);

    const far = fixture({ formationChanges: { full: false, bounds: [{ minX: 5000, minZ: 5000, maxX: 5100, maxZ: 5100 }] } });
    far.drain(); far.setPendingRoad(true);
    assert.notEqual(far.step(), 'wait', 'a pending change 5 km away never holds this tile');
    far.finish();
});

test('eviction or cancellation discards validation, while untracked tiles still rebuild', () => {
    const f = fixture();
    f.drain(); f.step();
    f.context.streamedBuildingTiles.delete('0_0');
    f.finish();
    assert.equal(f.context.terrainBuildingRebuildQueue.length, 0);
    assert.equal(f.dependencies.snapshot().retainedChecks, 0);
    assert.deepEqual(f.replacements, []);
    const cancelled = fixture();
    cancelled.drain(); cancelled.step();
    cancelled.jobs[0].options.onCancel();
    assert.equal(cancelled.context.terrainBuildingRebuildCheck, null);
    const untracked = fixture({ tracked: false });
    untracked.drain();
    assert.deepEqual(untracked.replacements, ['0_0']);
    assert.equal(untracked.jobs.length, 0);
});

test('initial ground gates construction once, while later publications use retained replacements', () => {
    let published = 0, builds = 0;
    const context = vm.createContext({
        initialBuildingGroundCoordinator: { snapshot: () => ({ published }) },
        buildingVisibilityBounds: () => null, buildingNowMs: () => 0,
        withTileBuildingSource: (_source, fn) => fn(),
        buildingFeatureNeedsTerrainEvidence: () => false,
        BUILDING_SOURCE: 'gdi', terrainReference: null,
        createGdiBuildingBuildTask: () => { builds++; return { step: () => ({ done: true }) }; },
    });
    const start = source.indexOf('function createBuildingFeatureWorkItem(');
    const end = source.indexOf('function describeBuildingFeatureWorkItem(', start);
    vm.runInContext(source.slice(start, end), context);
    const item = vm.runInContext("createBuildingFeatureWorkItem({}, '0_0', {})", context);
    assert.equal(item.step(), 'defer');
    assert.equal(item.isInProgress(), false);
    assert.equal(builds, 0, 'no survey transaction or resource reservation starts on provisional ground');
    const frameStart = source.indexOf('// Check once per frame,');
    const frameEnd = source.indexOf('const viewHeadingDeg', frameStart);
    const advanceFrame = () => vm.runInContext(source.slice(frameStart, frameEnd), context);
    advanceFrame();
    assert.equal(item.step(), 'defer');
    published = 1; advanceFrame();
    assert.equal(item.step(), 'done');
    assert.equal(builds, 1);
    published = 0; advanceFrame();
    assert.equal(context.initialBuildingGroundCoordinator, null, 'the startup gate never rearms during play');
});
