// A planner cab looks along the track across a chord, not along the edge it is on:
// edge bearings step at every vertex, which made the view twitch through curves.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= globalThis; // buildDriverGraph reads window.TramSwitchUtils
const { buildDriverGraph, computeDriverPose } = await import('../modes/driver.js');

const bend = buildDriverGraph([{ type: 'Feature', properties: {}, geometry: { type: 'LineString',
    coordinates: [[16.0, 45.73], [16.001, 45.73], [16.002, 45.7303]] } }]);
const [first, second] = bend.edges; // bearings 90° then ~66.7°
const justBefore = (direction = 1) => ({ edgeId: first.id, t: 1 - 0.5 / first.length, direction, speed: 0 });
const justAfter = (direction = 1) => ({ edgeId: second.id, t: 0.5 / second.length, direction, speed: 0 });
const turn = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('a chord heading turns smoothly across a vertex where the edge bearing steps', () => {
    const step = (opts) => turn(computeDriverPose(justAfter(), bend, opts).headingDeg,
        computeDriverPose(justBefore(), bend, opts).headingDeg);
    assert.ok(step({}) > 20, `edge bearings step by the whole bend (${step({})}°)`);
    assert.ok(step({ chordHeadingM: 8 }) < 3, `chord heading changes little over 1 m (${step({ chordHeadingM: 8 })}°)`);
});

test('mid-edge the chord heading is the edge bearing, and it reverses with the direction', () => {
    const mid = (direction) => computeDriverPose({ edgeId: first.id, t: 0.5, direction, speed: 0 }, bend, { chordHeadingM: 8 });
    assert.ok(turn(mid(1).headingDeg, 90) < 0.01);
    assert.ok(turn(mid(-1).headingDeg, 270) < 0.01);
});

test('the chord only changes the heading, never the position', () => {
    const plain = computeDriverPose(justBefore(), bend);
    const chord = computeDriverPose(justBefore(), bend, { chordHeadingM: 8 });
    assert.deepEqual([chord.lat, chord.lon], [plain.lat, plain.lon]);
});
