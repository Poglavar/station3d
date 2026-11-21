// A building tile job must not wait on one feature whose terrain evidence is
// still streaming while its siblings could be built. Drives the real feature
// work item and priority rule through the real frame-chunk queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
    FRAME_CHUNK_WAIT_ITEM,
    getFrameChunkSchedulerSnapshot,
    resetFrameChunkObserver,
    setFrameChunkSchedulerMode,
} from '../core/frame-chunk-queue.js';

setFrameChunkSchedulerMode('legacy');
resetFrameChunkObserver();

const SRC = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
const PRIORITY_SRC = slice('const DEPENDENCY_PENDING_PRIORITY_PENALTY', 'function buildingVisibilityBounds(');
const WORK_ITEM_SRC = slice('function createBuildingFeatureWorkItem(', 'function cancelBuildingFeatureWorkItems(');

function realm() {
    const evidence = new Map();
    const built = [];
    const stepped = [];
    const context = vm.createContext({
        performance,
        FRAME_CHUNK_WAIT_ITEM,
        FRAME_CHUNK_REPEAT_ITEM,
        FOUNDATION_FORMATION_REACH_M: 24,
        BUILDING_SOURCE: 'gdi',
        initialBuildingGroundCoordinator: null,
        terrainReference: null,
        buildingVisibilityBounds: feature => feature.bounds,
        buildingNowMs: () => performance.now(),
        withTileBuildingSource: (source, fn) => fn(),
        buildingFeatureNeedsTerrainEvidence: () => true,
        buildingTerrainEvidenceState: feature => {
            stepped.push(feature.properties.id);
            return evidence.get(feature.properties.id) || 'ready';
        },
        createGdiBuildingBuildTask: feature => ({
            step: () => {
                built.push(feature.properties.id);
                return { done: true, phase: 'finalize' };
            },
            cancel() {},
        }),
        pendingRoadFormationChangeTouches: () => false,
        roadFormationWaitExpired: () => true,
        formationWaitStartMs: () => 0,
        foundationFormationWaitAllowanceMs: () => 0,
        getFrameChunkWorkMotionState: () => 'stationary',
        advanceBuildingRoadFormationDependency: () => 'ready',
        addBuildingFeature: () => {},
        classifyBuildingWorkItem: item => ({ tier: 'visible', score: item.feature.properties.score }),
    });
    vm.runInContext(`${PRIORITY_SRC}\n${WORK_ITEM_SRC}`, context);
    const fn = name => vm.runInContext(name, context);
    return {
        evidence,
        built,
        stepped,
        createItem: (id, score) => fn('createBuildingFeatureWorkItem')(
            { properties: { id, score }, bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } }, '0_0', {}, 'gdi'),
        itemPriority: fn('buildingWorkItemPriority'),
        advance: fn('advanceBuildingFeatureWorkItem'),
        describe: fn('describeBuildingFeatureWorkItem'),
    };
}

function withIdleFlushes(run) {
    const originalRequest = globalThis.requestIdleCallback;
    const originalCancel = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    const flush = () => {
        const callback = callbacks.shift();
        assert.ok(callback, 'the queue must have scheduled a flush');
        callback({ timeRemaining: () => 10 });
    };
    try {
        return run(flush);
    } finally {
        globalThis.requestIdleCallback = originalRequest;
        globalThis.cancelIdleCallback = originalCancel;
    }
}

test('a tile job builds its runnable features before revisiting one whose terrain evidence is pending', () => {
    const { evidence, built, stepped, createItem, itemPriority, advance, describe } = realm();
    evidence.set('A', 'pending');
    // A ranks first by view, exactly the case that used to pin the whole tile.
    const a = createItem('A', 100);
    const b = createItem('B', 10);
    const c = createItem('C', 5);
    const queue = createFrameChunkQueue({ label: 'evidence-pending-order' });
    withIdleFlushes(flush => {
        let completed = false;
        queue.enqueue([a, b, c], advance, {
            itemPriority,
            reorderBetweenItems: true,
            describeItem: describe,
            onComplete: () => { completed = true; },
        });
        flush();
        assert.equal(a.lastPhase(), 'terrain-evidence-wait', 'the pending feature names its wait');
        assert.equal(a.dependencyPending(), true);
        assert.deepEqual(built, [], 'the first flush spends its slice on the pending feature');
        const named = getFrameChunkSchedulerSnapshot().queues
            .find(entry => entry.label === 'evidence-pending-order')?.deferring?.[0]?.label || '';
        assert.match(named, /gdi\/unknown-source A .*\[terrain-evidence-wait\]/, 'the streaming report names the pending feature');
        assert.ok(itemPriority(a) < itemPriority(c), 'a pending feature ranks below every runnable sibling');
        assert.ok(itemPriority(a) > -Number.MAX_SAFE_INTEGER, 'but above the tile finalization item');

        flush();
        assert.deepEqual(built, ['B', 'C'], 'the second flush builds both runnable siblings in view order');
        assert.equal(a.isDone(), false);
        assert.equal(completed, false);
        const stepsBeforeReady = stepped.filter(id => id === 'A').length;

        evidence.set('A', 'ready');
        flush();
        assert.deepEqual(built, ['B', 'C', 'A'], 'the pending feature is built once its evidence lands');
        assert.equal(a.dependencyPending(), false);
        assert.equal(a.lastPhase(), 'finalize');
        assert.equal(completed, true, 'the tile job completes');
        assert.ok(stepsBeforeReady <= 2, `the pending feature is probed once per flush, not once per sibling (${stepsBeforeReady})`);
    });
});

test('a feature with permanent no-data completes without pinning the tile', () => {
    const { evidence, built, createItem, itemPriority, advance } = realm();
    evidence.set('A', 'no-data');
    const a = createItem('A', 100);
    const b = createItem('B', 10);
    const queue = createFrameChunkQueue({ label: 'evidence-no-data' });
    withIdleFlushes(flush => {
        queue.enqueue([a, b], advance, { itemPriority, reorderBetweenItems: true });
        flush();
        assert.equal(a.isDone(), true);
        assert.equal(a.lastPhase(), 'terrain-no-data');
        assert.equal(a.dependencyPending(), false, 'a finished item is not pending');
        assert.deepEqual(built, ['B']);
    });
});

test('the tile finalization item ranks below every unfinished feature, pending ones included', () => {
    assert.match(SRC, /viewPriority: \(\) => \{\s*if \(featureWorkItems\.some\(featureItem => !featureItem\.isDone\(\)\)\) \{\s*return \{ score: -Number\.MAX_SAFE_INTEGER \};/,
        'finalization must stay last, or a demoted pending feature would never be probed again');
    assert.match(PRIORITY_SRC, /score - DEPENDENCY_PENDING_PRIORITY_PENALTY/);
});
