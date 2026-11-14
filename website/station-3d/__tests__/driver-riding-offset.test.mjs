// A cab on a planner line rides its running track, not the line's axis: the
// riding offset moves the pose (and every articulated car) right of travel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDriverPose } from '../modes/driver.js';
import { geoToLocal } from '../core/math.js';

// One eastbound edge of 200 m along the 45.73° parallel.
const LAT = 45.73;
const LON1 = 16.0;
const LON2 = LON1 + 200 / (111320 * Math.cos(LAT * Math.PI / 180));
const graph = {
    edges: [{ id: 0, lineIdx: 3, lat1: LAT, lng1: LON1, lat2: LAT, lng2: LON2, bearing: 90, length: 200 }],
    nodes: {},
    adj: {},
};
const state = (direction) => ({ edgeId: 0, t: 0.5, direction, speed: 0, throttle: 0 });
const local = (pose) => geoToLocal(pose.lon, pose.lat, LON1, LAT);

test('no riding offset keeps the pose on the line', () => {
    const pose = computeDriverPose(state(1), graph);
    assert.ok(Math.abs(local(pose).z) < 1e-6);
});

test('the offset puts an eastbound cab south of the axis, a westbound one north', () => {
    const seen = [];
    const ridingOffsetM = (edge, at) => { seen.push([edge.lineIdx, at.headingDeg]); return 6.6; };
    const east = local(computeDriverPose(state(1), graph, { ridingOffsetM }));
    const west = local(computeDriverPose(state(-1), graph, { ridingOffsetM }));
    // Scene z grows southwards (geoToLocal): right of an eastbound heading is south.
    assert.ok(Math.abs(east.z - 6.6) < 0.05, `eastbound z ${east.z}`);
    assert.ok(Math.abs(west.z + 6.6) < 0.05, `westbound z ${west.z}`);
    assert.deepEqual(seen, [[3, 90], [3, 270]]);
});

test('a zero or missing offset leaves the pose alone', () => {
    const plain = computeDriverPose(state(1), graph);
    for (const value of [0, NaN, undefined]) {
        const pose = computeDriverPose(state(1), graph, { ridingOffsetM: () => value });
        assert.deepEqual([pose.lat, pose.lon], [plain.lat, plain.lon]);
    }
});
