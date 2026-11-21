// Verifies the browser-independent placement contract for the driven train headlight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveRailHeadlightFrame } from '../core/rail-headlight.js';

test('the train headlight starts at the leading nose and aims forward and down', () => {
    const frame = resolveRailHeadlightFrame({
        x: 10,
        railY: 2,
        z: -5,
        forwardX: 3,
        forwardZ: 4,
        halfLengthM: 35,
        on: true,
    });

    assert.ok(frame);
    assert.ok(frame.position.x > 30 && frame.position.z > 20,
        'the normalized heading places the lamp at the leading nose');
    assert.ok(frame.target.x > frame.position.x && frame.target.z > frame.position.z,
        'the beam continues in the direction of travel');
    assert.ok(frame.target.y < frame.position.y, 'the beam reaches the track ahead');
});

test('the train headlight has no active frame during daylight or with an invalid pose', () => {
    assert.equal(resolveRailHeadlightFrame({
        x: 0,
        railY: 0,
        z: 0,
        forwardX: 0,
        forwardZ: -1,
        on: false,
    }), null);
    assert.equal(resolveRailHeadlightFrame({
        x: 0,
        railY: 0,
        z: 0,
        forwardX: 0,
        forwardZ: 0,
        on: true,
    }), null);
});

test('cab mode updates and disposes the scene-level train headlight', async () => {
    const source = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
    assert.match(source, /updateRailHeadlight\(\{[\s\S]*cabState\.isTrainSession[\s\S]*isSceneNight\(\)/);
    assert.match(source, /export function closeCab\(\)[\s\S]*disposeRailHeadlight\(\)/);
});
