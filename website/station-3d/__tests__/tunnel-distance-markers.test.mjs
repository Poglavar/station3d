// Headless unit tests for the tunnel distance-marker planner. Run:
// npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTunnelDistanceMarkers } from '../core/tunnel-distance-markers.js';

test('markers on a fixed 50 m grid show exact remaining distance to each portal', () => {
    // The worked example from the request: a 395 m bore reads 345, 295, 245, ...
    // on the wall counting down to the far end — decreasing by 50, NOT rounded
    // to the grid, because the portal sits at an arbitrary chainage.
    const plan = planTunnelDistanceMarkers([{ startM: 0, endM: 395 }]);
    assert.deepEqual(plan.map((m) => m.chainageM), [50, 100, 150, 200, 250, 300, 350]);
    assert.deepEqual(plan.map((m) => m.rightM), [345, 295, 245, 195, 145, 95, 45]);
    assert.deepEqual(plan.map((m) => m.leftM), [50, 100, 150, 200, 250, 300, 350]);
});

test('portals at arbitrary chainages offset both walls independently', () => {
    const plan = planTunnelDistanceMarkers([{ startM: 320, endM: 780 }]);
    assert.deepEqual(plan.map((m) => m.chainageM), [350, 400, 450, 500, 550, 600, 650, 700, 750]);
    assert.deepEqual(plan.map((m) => m.rightM), [430, 380, 330, 280, 230, 180, 130, 80, 30]);
    assert.deepEqual(plan.map((m) => m.leftM), [30, 80, 130, 180, 230, 280, 330, 380, 430]);
});

test('spans shorter than the spacing grid carry no signage', () => {
    assert.deepEqual(planTunnelDistanceMarkers([{ startM: 0, endM: 40 }]), []);
    // Exactly 50 m starting ON the grid: the only candidate chainage is the
    // portal itself — nothing fits inside.
    assert.equal(planTunnelDistanceMarkers([{ startM: 0, endM: 50 }]).length, 0);
    // Exactly 50 m OFF the grid: one chainage falls inside, reading 40/10.
    assert.deepEqual(planTunnelDistanceMarkers([{ startM: 10, endM: 60 }]).map(
        (m) => [m.chainageM, m.leftM, m.rightM]), [[50, 40, 10]]);
    assert.equal(planTunnelDistanceMarkers([{ startM: 0, endM: 55 }]).length, 1);
});

test('a plate never reads 0 m — the side that rounds to nothing is dropped', () => {
    // Marker 2 m past the span start: left remaining rounds to 0 → null side.
    const plan = planTunnelDistanceMarkers([{ startM: 48, endM: 300 }]);
    const first = plan[0];
    assert.equal(first.chainageM, 50);
    assert.equal(first.leftM, null);
    assert.equal(first.rightM, 250);
    for (const m of plan) assert.ok(m.rightM != null || m.leftM != null);
});

test('remaining distances round to wayfinding precision (5 m)', () => {
    const plan = planTunnelDistanceMarkers([{ startM: 3, endM: 213 }]);
    assert.deepEqual(plan.map((m) => [m.chainageM, m.leftM, m.rightM]), [
        [50, 45, 165],
        [100, 95, 115],
        [150, 145, 65],
        [200, 195, 15],
    ]);
});

test('multiple disjoint spans count to their own portals; junk is ignored', () => {
    const plan = planTunnelDistanceMarkers([
        { startM: 1000, endM: 1200 },
        { startM: 0, endM: 130 },
        { startM: Number.NaN, endM: 50 },
        { endM: 400 },
        null,
    ]);
    assert.deepEqual(plan.map((m) => m.chainageM), [50, 100, 1050, 1100, 1150]);
    assert.deepEqual(plan.slice(2).map((m) => m.rightM), [150, 100, 50]);
    assert.deepEqual(planTunnelDistanceMarkers(null), []);
    assert.deepEqual(planTunnelDistanceMarkers([]), []);
    assert.deepEqual(planTunnelDistanceMarkers([{ startM: 0, endM: 500 }], { spacingM: 0 }), []);
});
