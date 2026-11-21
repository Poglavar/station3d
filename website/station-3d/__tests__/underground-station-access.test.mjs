// An underground station has to make sense at ANY depth. The access stair used
// to run a fixed distance from the mezzanine to the street, which is a normal
// stair at exactly one depth and a ladder at every other. These are the rules
// that make the run follow the rise instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    planUndergroundAccessStairs,
    accessStairRunForRiseM,
    accessStairStepCount,
    ACCESS_STAIR_RISER_M,
    ACCESS_STAIR_TREAD_M,
    ACCESS_MAX_FLIGHT_RISE_M,
} from '../core/underground-station-access.js';

// Slope of every flight in a plan, as rise/run.
function flightPitches(plan) {
    return plan.flights.map((f) => Math.abs(f.toY - f.fromY) / Math.abs(f.toAlongM - f.fromAlongM));
}

test('the pitch is the same at every depth — that is the whole point', () => {
    // The old geometry: 3.86 m over a fixed 7.7 m run is 1:2 (fine), but the
    // same 7.7 m under a 20 m-deep station is 13.9 m of rise — a 61° ladder.
    const expected = ACCESS_STAIR_RISER_M / ACCESS_STAIR_TREAD_M;
    for (const riseM of [1.5, 3.9, 8, 13.9, 25]) {
        const plan = planUndergroundAccessStairs(0, riseM);
        for (const pitch of flightPitches(plan)) {
            assert.ok(Math.abs(pitch - expected) < 1e-9,
                `rise ${riseM} m gave pitch 1:${(1 / pitch).toFixed(2)}`);
        }
    }
});

test('a deeper station gets a longer shaft, not a steeper one', () => {
    const shallow = planUndergroundAccessStairs(-3.9, 0.06);
    const deep = planUndergroundAccessStairs(-13.9, 0.06);
    assert.ok(deep.totalRunM > shallow.totalRunM * 2.5,
        `deep run ${deep.totalRunM} vs shallow ${shallow.totalRunM}`);
    assert.ok(deep.flightCount > shallow.flightCount, 'deeper climb gets more flights');
});

test('no flight climbs more than the landing cap', () => {
    for (const riseM of [3, 6, 12, 30]) {
        const plan = planUndergroundAccessStairs(0, riseM);
        for (const flight of plan.flights) {
            assert.ok(Math.abs(flight.toY - flight.fromY) <= ACCESS_MAX_FLIGHT_RISE_M + 1e-9,
                `flight rises ${(flight.toY - flight.fromY).toFixed(2)} m at total ${riseM} m`);
        }
    }
});

test('landings sit between flights, never at the top', () => {
    const plan = planUndergroundAccessStairs(-13.9, 0.06);
    assert.equal(plan.segments[0].kind, 'flight', 'starts climbing');
    assert.equal(plan.segments[plan.segments.length - 1].kind, 'flight',
        'a landing at the top would push the entrance past its own well');
    assert.equal(plan.landings.length, plan.flightCount - 1);
    for (const landing of plan.landings) {
        assert.equal(landing.fromY, landing.toY, 'a landing is level');
    }
});

test('the climb is continuous and lands exactly on the street', () => {
    // Gaps or overlaps between segments are holes you fall through.
    const plan = planUndergroundAccessStairs(-13.9, 0.06);
    for (let i = 1; i < plan.segments.length; i++) {
        const prev = plan.segments[i - 1], next = plan.segments[i];
        assert.ok(Math.abs(prev.toAlongM - next.fromAlongM) < 1e-9, `along gap at ${i}`);
        assert.ok(Math.abs(prev.toY - next.fromY) < 1e-9, `height gap at ${i}`);
    }
    const last = plan.segments[plan.segments.length - 1];
    assert.ok(Math.abs(last.toY - 0.06) < 1e-9, `top tread at ${last.toY}, not the street`);
    assert.ok(Math.abs(plan.topAlongM - plan.segments[0].fromAlongM) - plan.totalRunM < 1e-9);
});

test('direction and start offset are respected', () => {
    const forward = planUndergroundAccessStairs(-4, 0, { startAlongM: 17, direction: 1 });
    const back = planUndergroundAccessStairs(-4, 0, { startAlongM: -17, direction: -1 });
    assert.ok(forward.topAlongM > 17, 'climbs away from the platform');
    assert.ok(back.topAlongM < -17, 'and mirrors on the other side');
    assert.ok(Math.abs(forward.totalRunM - back.totalRunM) < 1e-9, 'same length either way');
});

test('nothing to climb produces no stair', () => {
    // A mezzanine already at street level must not emit a lip of treads.
    for (const [from, to] of [[0, 0], [0, 0.2], [0, -5]]) {
        const plan = planUndergroundAccessStairs(from, to);
        assert.equal(plan.segments.length, 0, `${from}→${to}`);
        assert.equal(plan.totalRunM, 0);
        assert.equal(plan.topAlongM, 0, 'the entrance stays where the well starts');
    }
    assert.deepEqual(planUndergroundAccessStairs(NaN, 3).segments, []);
});

test('step count and run agree with the riser/tread the steps are built from', () => {
    assert.equal(accessStairStepCount(ACCESS_STAIR_RISER_M * 12), 12);
    assert.equal(accessStairStepCount(0), 1, 'never a zero-step flight');
    assert.ok(Math.abs(accessStairRunForRiseM(1.7) - 3.0) < 1e-9);
    // Every flight's own steps × riser reproduces its rise, so treads land on
    // the slope the renderer draws rather than drifting off it.
    const plan = planUndergroundAccessStairs(-9, 0);
    for (const flight of plan.flights) {
        const riseM = flight.toY - flight.fromY;
        const runM = Math.abs(flight.toAlongM - flight.fromAlongM);
        assert.ok(Math.abs(runM / flight.stepCount - ACCESS_STAIR_TREAD_M) < 0.02,
            `tread depth ${(runM / flight.stepCount).toFixed(3)} m`);
        assert.ok(Math.abs(riseM / flight.stepCount - ACCESS_STAIR_RISER_M) < 0.02);
    }
});
