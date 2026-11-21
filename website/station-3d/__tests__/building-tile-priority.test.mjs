// Locks the scheduling bands that put the initial visible building tiles ahead
// of speculative corridor and ordinary streamed work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingTileBuildPriority } from '../core/building-tile-priority.js';

test('initial reveal tiles outrank every ordinary corridor tile', () => {
    const worstInitialView = buildingTileBuildPriority(-1e13, { initialNear: true });
    const bestCorridorView = buildingTileBuildPriority(1e13);

    assert.ok(worstInitialView > bestCorridorView);
});

test('a staged building transaction finishes before an unstarted initial tile', () => {
    const stagedCorridor = buildingTileBuildPriority(-1e13, { inProgress: true });
    const bestInitial = buildingTileBuildPriority(1e13, { initialNear: true });

    assert.ok(stagedCorridor > bestInitial);
});

test('an initial tile with staged work is the highest priority class', () => {
    const stagedInitial = buildingTileBuildPriority(-1e13, {
        initialNear: true,
        inProgress: true,
    });
    const stagedCorridor = buildingTileBuildPriority(1e13, { inProgress: true });

    assert.ok(stagedInitial > stagedCorridor);
});

test('invalid view scores cannot escape their scheduling class', () => {
    assert.equal(buildingTileBuildPriority(Number.NaN), 0);
    assert.equal(buildingTileBuildPriority(Infinity, { initialNear: true }), 1e14);
});
