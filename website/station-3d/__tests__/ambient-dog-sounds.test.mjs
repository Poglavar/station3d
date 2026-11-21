// Unit coverage for dog-call cadence and camera-relative spatial falloff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';

import {
    DOG_BARK_MAX_DISTANCE_M,
    dogBarkSpatial,
    nextDogBarkDelayS,
} from '../core/ambient-dog-sounds.js';

test('dog bark cadence starts promptly, then remains sparse', () => {
    assert.equal(nextDogBarkDelayS({ first: true, randomValue: 0 }), 8);
    assert.equal(nextDogBarkDelayS({ first: true, randomValue: 1 }), 22);
    assert.equal(nextDogBarkDelayS({ randomValue: 0 }), 20);
    assert.equal(nextDogBarkDelayS({ randomValue: 1 }), 50);
    assert.equal(nextDogBarkDelayS({ foundDog: false, randomValue: 0.5 }), 7.5);
});

test('dog bark spatial policy rejects distant dogs and pans along camera right', () => {
    assert.equal(dogBarkSpatial({
        dogX: DOG_BARK_MAX_DISTANCE_M + 1,
        dogZ: 0,
        cameraX: 0,
        cameraZ: 0,
    }), null);
    const nearby = dogBarkSpatial({
        dogX: 10,
        dogZ: 0,
        cameraX: 0,
        cameraZ: 0,
        cameraRightX: 1,
        cameraRightZ: 0,
    });
    assert.equal(nearby.distanceM, 10);
    assert.equal(nearby.pan, 1);
    assert.ok(nearby.gain > 0.35);
});

test('the three credited dog bark clips ship with the Station3D bundle', async () => {
    const assetUrls = [1, 2, 3].map(index => new URL(
        `../audio/sfx/dogs/dog-bark-${index}.wav`,
        import.meta.url,
    ));
    const sizes = await Promise.all(assetUrls.map(assetUrl => stat(assetUrl)));
    assert.ok(sizes.every(({ size }) => size > 1024));
    assert.ok((await stat(new URL(
        '../audio/sfx/dogs/SOURCES.md',
        import.meta.url,
    ))).size > 0);
});

test('a dog on the pavement is out of earshot for a listener high above it', async () => {
    const { dogBarkSpatial } = await import('../core/ambient-dog-sounds.js');
    const base = { dogX: 10, dogZ: 0, cameraX: 0, cameraZ: 0, cameraRightX: 1, cameraRightZ: 0 };
    const street = dogBarkSpatial({ ...base, dogY: 0.4, cameraY: 1.7 });
    assert.ok(street && street.gain > 0.3);
    assert.equal(dogBarkSpatial({ ...base, dogY: 0.4, cameraY: 250 }), null, 'a pilot hears no dogs');
    assert.deepEqual(dogBarkSpatial(base), dogBarkSpatial({ ...base, dogY: null, cameraY: null }));
});
