import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiftMotion, sampleLiftMotion } from '../core/lift-motion.js';

test('models all phases and smooth intermediate travel', () => {
    const motion = createLiftMotion({ fromY: 10, toY: 110, speedMps: 10 });
    assert.equal(motion.durationS, 21);
    assert.equal(sampleLiftMotion(motion, 0).phase, 'opening');
    assert.equal(sampleLiftMotion(motion, 3.5).phase, 'traveling');
    assert.ok(sampleLiftMotion(motion, 4).floorY > 10 && sampleLiftMotion(motion, 4).floorY < 110);
    assert.equal(sampleLiftMotion(motion, motion.durationS).done, true);
});

test('supports equal endpoints and downward travel', () => {
    const same = createLiftMotion({ fromY: 4, toY: 4 });
    assert.equal(same.travelS, 2);
    assert.equal(sampleLiftMotion(same, 4).floorY, 4);
    const down = createLiftMotion({ fromY: 100, toY: 0, speedMps: 20 });
    assert.ok(sampleLiftMotion(down, 4).floorY < 100);
    assert.equal(sampleLiftMotion(down, down.durationS + 10).floorY, 0);
});

test('clamps negative time and rejects invalid parameters', () => {
    const motion = createLiftMotion({ fromY: 0, toY: 10 });
    assert.equal(sampleLiftMotion(motion, -5).phase, 'opening');
    assert.throws(() => createLiftMotion({ fromY: 0, toY: Infinity }), /finite/);
    assert.throws(() => createLiftMotion({ fromY: 0, toY: 1, speedMps: 0 }), /positive/);
});
