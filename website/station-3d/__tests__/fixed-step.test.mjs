import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFixedStepAccumulator } from '../core/fixed-step.js';

const CARS_SOURCE = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8');

test('fixed step caps catch-up and reports discarded simulation time', () => {
    const accumulator = createFixedStepAccumulator({ stepSeconds: 0.01, maxSubsteps: 4 });
    let calls = 0;
    const result = accumulator.advance(0.105, () => { calls += 1; });
    assert.equal(calls, 4);
    assert.equal(result.steps, 4);
    assert.ok(Math.abs(result.discardedSeconds - 0.06) < 1e-9);
    assert.ok(result.alpha > 0.49 && result.alpha < 0.51);
});

test('fixed step carries a fractional remainder to the next frame', () => {
    const accumulator = createFixedStepAccumulator({ stepSeconds: 0.02, maxSubsteps: 4 });
    let calls = 0;
    accumulator.advance(0.015, () => { calls += 1; });
    accumulator.advance(0.010, () => { calls += 1; });
    assert.equal(calls, 1);
});

test('ambient traffic is one bounded fixed update with interpolated rendering', () => {
    assert.match(CARS_SOURCE, /const TRAFFIC_STEP_HZ = 30;/);
    assert.match(CARS_SOURCE, /maxSubsteps: 1,/);
    assert.match(CARS_SOURCE, /trafficFixedStep\.advance\(dt, fixedDt => \{/);
    assert.match(CARS_SOURCE, /updateGlobalCars\(fixedDt, local\.x, local\.z\);/);
    assert.match(CARS_SOURCE, /interpolateTrafficRenderPoses\(trafficFrame\.alpha\);/);
    assert.match(CARS_SOURCE, /if \(trafficFrame\.steps > 0\) applyAutopilotTramStalls\(\);/,
        'ambient tram obstacle scans must share the bounded traffic cadence');
    assert.match(CARS_SOURCE, /allowStale: true/,
        'traffic ground placement must not trigger a whole road-model rebuild');
});
