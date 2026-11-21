import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RAIN_PARTICLE_COUNTS,
    buildRainField,
    rainParticleCountForQuality,
} from '../core/rain-field.js';

test('rain particle budgets follow the renderer quality profile', () => {
    assert.equal(rainParticleCountForQuality('high'), RAIN_PARTICLE_COUNTS.high);
    assert.equal(rainParticleCountForQuality('medium'), RAIN_PARTICLE_COUNTS.medium);
    assert.equal(rainParticleCountForQuality('low'), RAIN_PARTICLE_COUNTS.low);
    assert.equal(rainParticleCountForQuality('unknown'), RAIN_PARTICLE_COUNTS.medium);
});

test('rain field is deterministic and bounded in its normalized volume', () => {
    const first = buildRainField(64, 42);
    const second = buildRainField(64, 42);
    assert.deepEqual(first.positions, second.positions);
    assert.deepEqual(first.phases, second.phases);
    assert.deepEqual(first.scales, second.scales);
    assert.equal(first.positions.length, 64 * 3);
    for (let index = 0; index < first.count; index++) {
        const x = first.positions[index * 3];
        const y = first.positions[index * 3 + 1];
        const z = first.positions[index * 3 + 2];
        assert.ok(Math.hypot(x, z) <= 1.000001);
        assert.ok(y >= 0 && y < 1);
        assert.ok(first.phases[index] >= 0 && first.phases[index] < 1);
        assert.ok(first.scales[index] >= 0.45 && first.scales[index] <= 1);
    }
});
