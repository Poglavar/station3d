import assert from 'node:assert/strict';
import test from 'node:test';
import { rebaseSessionRestorePoint } from '../core/session-restore.js';

test('reopening at another terrain anchor preserves a walking height and vertical motion', () => {
    const saved = {
        altitudeDatumM: 113.5, pose: { lat: 45.8, lon: 15.9, y: 0.04 },
        walkMotion: { y: 0.04, vy: -2, initialGroundY: null, lastDetectedGroundY: 0.04,
            spawnY: 0, lat: 45.8, lon: 15.9, airborne: true },
    };
    const result = rebaseSessionRestorePoint(saved, 114.5);
    assert.equal(result.pose.y, -0.96);
    assert.equal(result.pose.y + result.altitudeDatumM, saved.pose.y + saved.altitudeDatumM);
    assert.deepEqual(result.walkMotion, { ...saved.walkMotion, y: -0.96,
        lastDetectedGroundY: -0.96, spawnY: -1 });
    assert.equal(saved.walkMotion.y, 0.04, 'capture remains unchanged');
});

test('vehicle and special-vehicle heights change origin without changing velocities', () => {
    const saved = { altitudeDatumM: 50, pose: { y: 3 },
        vehicleMotion: { y: 3, groundY: 2, velocity: { x: 2, y: 3, z: 4 },
            special: { x: 1, z: 2, y: 3, speedMps: 8 } } };
    const result = rebaseSessionRestorePoint(saved, 70);
    assert.equal(result.vehicleMotion.y, -17);
    assert.equal(result.vehicleMotion.groundY, -18);
    assert.deepEqual(result.vehicleMotion.special, { x: 1, z: 2, y: -17, speedMps: 8 });
    assert.deepEqual(result.vehicleMotion.velocity, saved.vehicleMotion.velocity);
});

test('a missing height origin is never treated as sea level', () => {
    for (const absent of [null, undefined, NaN]) {
        const saved = { altitudeDatumM: absent, pose: { y: 3 } };
        assert.equal(rebaseSessionRestorePoint(saved, 80), saved);
        const valid = { altitudeDatumM: 80, pose: { y: 3 } };
        assert.equal(rebaseSessionRestorePoint(valid, absent), valid);
    }
    assert.equal(rebaseSessionRestorePoint(null, 0), null);
});
