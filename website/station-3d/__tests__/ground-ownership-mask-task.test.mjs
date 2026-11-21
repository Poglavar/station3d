import test from 'node:test';
import assert from 'node:assert/strict';

import {
    captureFormationMaskInputs,
    formationMaskProfiles,
    formationMaskRevision,
    formationMaskTaskNeedsRestart,
} from '../core/ground-ownership-mask-task.js';

test('pending road formation exposes its last complete local publication without a forced rebuild', () => {
    const publishedProfile = { osmId: '285216602' };
    const replacementRegions = [{ id: 'underpass' }];
    const calls = [];
    const model = {
        revision: 119,
        hasPendingBuild: () => true,
        getSurfaceProfiles() {
            throw new Error('must not synchronously finish a pending formation');
        },
        surfaceProfilesNear(x, z, radiusM, options) {
            calls.push({ x, z, radiusM, options });
            return [publishedProfile];
        },
        getReplacementTerrainCutoutRegions: () => replacementRegions,
        getTunnelPortalTerrainOpenings: () => [],
    };

    const captured = captureFormationMaskInputs([model], {
        centerX: -2214,
        centerZ: 423,
        radiusM: 1800,
    });
    assert.deepEqual(calls, [{
        x: -2214,
        z: 423,
        radiusM: 1800,
        options: { allowStale: true },
    }]);
    assert.deepEqual(captured[0].profiles, [publishedProfile]);
    assert.deepEqual(captured[0].replacementRegions, replacementRegions);
    replacementRegions.push({ id: 'later' });
    assert.equal(captured[0].replacementRegions.length, 1, 'task input is an atomic array snapshot');
});

test('a pending model without a stale-publication accessor cannot be sampled', () => {
    const model = {
        hasPendingBuild: () => true,
        getSurfaceProfiles() {
            throw new Error('unbounded getter');
        },
    };
    assert.equal(formationMaskProfiles(model, 0, 0, 100), null);
    assert.equal(captureFormationMaskInputs([model], { radiusM: 100 }), null);
});

test('mask revision distinguishes pending input from the completed generation', () => {
    let pending = true;
    const model = { revision: 12, hasPendingBuild: () => pending };
    assert.equal(formationMaskRevision([model]), '12:0:pending');
    model.surfacePublicationRevision = 3;
    assert.equal(formationMaskRevision([model]), '12:3:pending');
    pending = false;
    assert.equal(formationMaskRevision([model]), '12:3:ready');
});

test('captured task survives source churn and restarts only when its spatial window moves', () => {
    const model = { revision: 4 };
    const task = { models: [model], centerX: -2000, centerZ: 100, revision: '4:0:ready' };
    model.revision = 5;
    assert.equal(
        formationMaskTaskNeedsRestart(task, [model], -2214, 423, 400),
        false,
        'newer generation queues a successor instead of starving this task',
    );
    assert.equal(
        formationMaskTaskNeedsRestart(task, [model], -2500, 423, 400),
        true,
    );
    assert.equal(
        formationMaskTaskNeedsRestart(task, [{}], -2214, 423, 400),
        true,
        'a different authority object is a real invalidation',
    );
});
