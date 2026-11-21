// Verifies automatic pedestrian doors open, hold, and close without relying
// on a browser or Three.js scene.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    holdSlidingDoorOpen,
    stepSlidingDoor,
} from '../core/sliding-door-motion.js';

test('automatic door opens while held and closes after the hold expires', () => {
    const door = { ratio: 0, holdSeconds: 0 };
    holdSlidingDoorOpen(door, 1);

    stepSlidingDoor(door, 0.25, { openRate: 2, closeRate: 1 });
    assert.equal(door.ratio, 0.5);
    assert.equal(door.holdSeconds, 0.75);

    stepSlidingDoor(door, 0.25, { openRate: 2, closeRate: 1 });
    assert.equal(door.ratio, 1);
    assert.equal(door.holdSeconds, 0.5);

    stepSlidingDoor(door, 0.5, { openRate: 2, closeRate: 1 });
    assert.equal(door.ratio, 0.5);
    assert.equal(door.holdSeconds, 0);

    stepSlidingDoor(door, 0.5, { openRate: 2, closeRate: 1 });
    assert.equal(door.ratio, 0);
});

test('a new crossing extends an existing automatic-door hold', () => {
    const door = { ratio: 1, holdSeconds: 0.4 };
    holdSlidingDoorOpen(door, 1.2);
    assert.equal(door.holdSeconds, 1.2);
});
