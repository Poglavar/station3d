// Characterize the actual pedestrian lifecycle: a paused/loading session must
// prepare GPU programs before population, without publishing its warmup meshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createLayerStartupCoordinator } from '../core/layer-startup.js';

function fixture() {
    const source = readFileSync(new URL('../world/pedestrians.js', import.meta.url), 'utf8');
    const lifecycle = source.slice(source.indexOf('export const pedestriansLayer ='))
        .replace('export const pedestriansLayer =', 'globalThis.layer =');
    const scene = new THREE.Scene(), warmups = [], kinds = [];
    let ticks = 0, now = 0;
    const errors = [];
    const sandbox = {
        THREE, scene, camera: {}, renderer: {},
        terrainChangeSubscription: null, pedestrianMaterialWarmup: null, pedestrianShaderStartup: null,
        createLayerStartupCoordinator: options => createLayerStartupCoordinator({ ...options, now: () => now }),
        console: { error: (...args) => errors.push(args) },
        activeTerrainReference: () => null, createFeetGroundCache: () => ({ clear() {} }),
        nextDogBarkDelayS: () => 1,
        stopPoint: point => point, sessionGeneration: 0,
        conversationController: null, conversationListener: null,
        prepareAmbientPersonMeshAssets() {}, prepareDogMeshAssets() {},
        preloadDogSfx() {}, preloadPedestrianConversations() {},
        ensureRoadIndex: async () => {}, clearSlidingDoors() {},
        cancelRoadTargetSearch() {}, cancelRoofTargetSearch() {},
        stopDogSfx() {}, stopPedestrianConversations() {},
        doorPlaneGeo: null, doorBoxGeo: null, doorRecessMat: null, doorPanelMat: null, doorFrameMat: null,
        unregisterShared() {}, tick() { ticks++; },
        createPersonMesh({ kind }) { kinds.push(kind); return new THREE.Group(); },
        createLeashedDog() { return new THREE.Group(); },
        createQueuedShaderWarmup(root, options) {
            assert.equal(root.parent, null);
            assert.equal(root.children.length, 4, 'three leg schemas plus the dog/leash');
            assert.equal(options.targetScene, scene);
            let finish;
            const state = {
                ready: false, error: null, closed: false, disposed: 0,
                completion: new Promise(resolve => { finish = resolve; }),
                fail(error) { this.error = error; finish(this); },
                succeed() { this.ready = true; finish(this); },
                dispose() {
                    if (this.closed) return;
                    this.closed = true; this.ready = false; this.disposed++; finish(this);
                },
            };
            warmups.push(state);
            return state;
        },
    };
    runInNewContext(lifecycle, sandbox);
    return { layer: sandbox.layer, scene, warmups, kinds, errors, ticks: () => ticks,
        advance(ms) { now += ms; },
        async flush() { for (let n = 0; n < 6; n++) await Promise.resolve(); },
    };
}

test('paused pedestrian startup warms real actor variants before advancing population', () => {
    const f = fixture();
    f.layer.beginSession({ allStops: [] });
    assert.equal(f.warmups.length, 1);
    assert.deepEqual(f.kinds, ['kid', 'female', 'male']);
    assert.equal(f.scene.children.length, 1);
    assert.equal(f.scene.children[0].children.length, 0, 'warmup actors never enter the scene');
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 0, 'movement cannot expose a cold shader');
    f.warmups[0].ready = true;
    f.layer.onFrame(null, null, 0);
    assert.equal(f.ticks(), 0, 'pause remains pause');
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 1);
    f.layer.endSession();
    assert.equal(f.warmups[0].disposed, 1);
    assert.equal(f.scene.children.length, 0);
});

test('ending and reopening keeps the new session behind its own shader readiness', () => {
    const f = fixture();
    f.layer.beginSession({ allStops: [] });
    f.layer.endSession();
    f.layer.beginSession({ allStops: [] });
    assert.equal(f.warmups[0].disposed, 1);
    f.warmups[0].ready = true;
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 0);
    f.warmups[1].ready = true;
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 1);
    f.layer.endSession();
});

test('a failed shader warmup retries while paused, keeps failure visible, and recovers population', async () => {
    const f = fixture();
    f.layer.beginSession({ allStops: [] });
    f.warmups[0].fail(new Error('transient driver failure'));
    await f.flush();
    assert.equal(f.warmups[0].disposed, 0, 'retain the failed readiness reader until replacement');
    f.advance(999);
    f.layer.onFrame(null, null, 0);
    assert.equal(f.warmups.length, 1, 'do not retry every frame');
    f.advance(1);
    f.layer.onFrame(null, null, 0);
    assert.equal(f.warmups.length, 2, 'the shared retry coordinator runs even while paused');
    assert.equal(f.warmups[0].disposed, 1);
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 0);
    f.warmups[1].succeed();
    await f.flush();
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 1);
    assert.equal(f.errors.length, 1, 'failure is not silently swallowed');
    f.layer.endSession();
});

test('a late failed startup cannot dispose or restart a newer session', async () => {
    const f = fixture();
    f.layer.beginSession({ allStops: [] });
    f.layer.endSession();
    f.layer.beginSession({ allStops: [] });
    f.warmups[0].fail(new Error('old session failure'));
    await f.flush();
    f.advance(20000);
    f.layer.onFrame(null, null, 0);
    assert.equal(f.warmups.length, 2);
    assert.equal(f.warmups[0].disposed, 1);
    assert.equal(f.warmups[1].disposed, 0);
    f.warmups[1].succeed();
    await f.flush();
    f.layer.onFrame(null, null, 0.016);
    assert.equal(f.ticks(), 1);
    f.layer.endSession();
});
