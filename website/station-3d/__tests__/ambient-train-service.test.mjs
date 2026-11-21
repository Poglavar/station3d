// Verifies persistent project trains brake, dwell, and reverse at line ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ambientTrainDoorRatio,
    createAmbientTrainServiceState,
    stepAmbientTrainServiceState,
} from '../core/ambient-train-service.js';

function stepUntil(state, predicate, maxSeconds = 300) {
    const events = [];
    for (let elapsed = 0; elapsed < maxSeconds; elapsed += 0.1) {
        events.push(...stepAmbientTrainServiceState(state, 0.1));
        if (predicate(state, events)) return events;
    }
    assert.fail(`condition not reached within ${maxSeconds}s`);
}

test('brakes into every station and holds the configured ten-second dwell', () => {
    const state = createAmbientTrainServiceState({
        totalLengthM: 400,
        stops: [
            { stopId: 'a', positionM: 0 },
            { stopId: 'b', positionM: 200 },
            { stopId: 'c', positionM: 400 },
        ],
        direction: 1,
        initialPositionM: 40,
        initialSpeedMps: 12,
        cruiseSpeedMps: 20,
        dwellSeconds: 10,
    });

    const events = stepUntil(
        state,
        (_current, seen) => seen.some(event => event.type === 'arrive'),
    );
    assert.equal(events.find(event => event.type === 'arrive').stop.stopId, 'b');
    assert.equal(state.positionM, 200);
    assert.equal(state.speedMps, 0);
    assert.equal(state.dwellRemainingS, 10);

    stepAmbientTrainServiceState(state, 9.9);
    assert.equal(state.positionM, 200);
    assert.equal(state.phase, 'dwelling');
    assert.ok(state.dwellRemainingS > 0);

    const departure = stepAmbientTrainServiceState(state, 0.2);
    assert.ok(departure.some(event => event.type === 'depart'));
    assert.ok(state.positionM > 200);
});

test('reverses only after dwelling at both termini', () => {
    const state = createAmbientTrainServiceState({
        totalLengthM: 120,
        stops: [
            { stopId: 'west', positionM: 0 },
            { stopId: 'east', positionM: 120 },
        ],
        direction: 1,
        initialPositionM: 110,
        initialSpeedMps: 8,
        cruiseSpeedMps: 12,
        dwellSeconds: 10,
    });

    stepUntil(state, current => current.phase === 'dwelling');
    assert.equal(state.positionM, 120);
    assert.equal(state.direction, 1);
    assert.equal(state.pendingDirection, -1);

    stepAmbientTrainServiceState(state, 10);
    assert.equal(state.direction, -1);
    assert.notEqual(state.phase, 'dwelling');

    stepUntil(state, current => current.phase === 'dwelling' && current.positionM === 0);
    assert.equal(state.direction, -1);
    assert.equal(state.pendingDirection, 1);
});

test('adds virtual termini when a service only declares intermediate stops', () => {
    const state = createAmbientTrainServiceState({
        totalLengthM: 100,
        stops: [{ stopId: 'middle', positionM: 50 }],
    });

    assert.deepEqual(
        state.stops.map(stop => [stop.stopId, stop.positionM, !!stop.isTerminus]),
        [
            [null, 0, true],
            ['middle', 50, false],
            [null, 100, true],
        ],
    );
});

test('opens ghost-train doors after arrival and closes them before departure', () => {
    const state = createAmbientTrainServiceState({
        totalLengthM: 100,
        stops: [{ stopId: 'a', positionM: 0 }, { stopId: 'b', positionM: 100 }],
        initialDwellSeconds: 10,
        dwellSeconds: 10,
    });

    assert.equal(ambientTrainDoorRatio(state), 0);
    stepAmbientTrainServiceState(state, 0.4);
    assert.ok(Math.abs(ambientTrainDoorRatio(state) - 0.5) < 1e-9);
    stepAmbientTrainServiceState(state, 0.5);
    assert.equal(ambientTrainDoorRatio(state), 1);
    stepAmbientTrainServiceState(state, 8.2);
    assert.ok(ambientTrainDoorRatio(state) < 1);
    stepAmbientTrainServiceState(state, 0.9);
    assert.equal(ambientTrainDoorRatio(state), 0);
});
