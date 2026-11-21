// Verifies the deterministic first dog, probabilistic follow-ups, and cap.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AMBIENT_DOG_WALKER_CHANCE,
    MAX_AMBIENT_DOG_WALKERS,
    shouldAttachAmbientDog,
} from '../core/ambient-dog-walkers.js';

test('first ambient group gets a dog and later groups follow the bounded chance', () => {
    assert.equal(shouldAttachAmbientDog({ currentDogWalkers: 0, randomValue: 1 }), true);
    assert.equal(shouldAttachAmbientDog({ currentDogWalkers: 1, randomValue: AMBIENT_DOG_WALKER_CHANCE / 2 }), true);
    assert.equal(shouldAttachAmbientDog({ currentDogWalkers: 1, randomValue: AMBIENT_DOG_WALKER_CHANCE }), false);
    assert.equal(shouldAttachAmbientDog({ currentDogWalkers: MAX_AMBIENT_DOG_WALKERS, randomValue: 0 }), false);
});
