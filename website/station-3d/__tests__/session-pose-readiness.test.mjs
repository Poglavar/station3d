// Locks live pose publication across foot, rail, and GTA vehicle controllers.
// A moving campaign boat must not keep publishing the walker pose it boarded from.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sessionPoseReadyForPublication } from '../core/session-pose-readiness.js';

test('a vehicle publishes its own pose without terrain support evidence', () => {
    assert.equal(sessionPoseReadyForPublication({
        vehicleController: true,
        terrainPresent: true,
        terrainSupportReady: false,
        groundY: null,
    }), true);
});

test('a foot pose still waits for terrain support when terrain is present', () => {
    assert.equal(sessionPoseReadyForPublication({
        footController: true,
        terrainPresent: true,
        terrainSupportReady: false,
    }), false);
    assert.equal(sessionPoseReadyForPublication({
        footController: true,
        terrainPresent: true,
        terrainSupportReady: true,
    }), true);
    assert.equal(sessionPoseReadyForPublication({
        footController: true,
        terrainPresent: false,
    }), true);
});

test('rail publication still requires a resolved model-world height', () => {
    assert.equal(sessionPoseReadyForPublication({ groundY: null }), false);
    assert.equal(sessionPoseReadyForPublication({ groundY: 0 }), true);
    assert.equal(sessionPoseReadyForPublication({ photoPoseReady: true }), true);
});

test('cab wiring identifies GTA vehicle controllers explicitly', () => {
    const source = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
    assert.match(source, /sessionPoseReadyForPublication\(\{/);
    assert.match(source, /vehicleController: gtaDriving/);
    assert.match(source, /footController: controllerCameraProfile\.kind === 'foot'/);
});
