// Locks signal phase timing and verifies only aligned vehicles approaching a
// red/amber stop line receive a braking factor.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    trafficSignalBrakeFactor,
    trafficSignalPhase,
} from '../core/traffic-signal-cycle.js';

const signal = { id: 'signal:1', x: 0, z: 10, bearingDeg: 0, phaseOffsetSeconds: 0 };

test('traffic signal cycle has green, amber and red phases', () => {
    assert.equal(trafficSignalPhase(signal, 5), 'green');
    assert.equal(trafficSignalPhase(signal, 11), 'amber');
    assert.equal(trafficSignalPhase(signal, 18), 'red');
});

test('red signals brake only aligned approaching traffic', () => {
    const approach = trafficSignalBrakeFactor({
        vehicleX: 0,
        vehicleZ: 0,
        heading: 0,
        signal,
        elapsedSeconds: 18,
    });
    assert.ok(approach > 0 && approach < 1);
    assert.equal(trafficSignalBrakeFactor({
        vehicleX: 0,
        vehicleZ: 12,
        heading: 0,
        signal,
        elapsedSeconds: 18,
    }), 1, 'signal behind the vehicle');
    assert.equal(trafficSignalBrakeFactor({
        vehicleX: -10,
        vehicleZ: 10,
        heading: Math.PI / 2,
        signal,
        elapsedSeconds: 18,
    }), 1, 'cross street does not inherit this approach signal');
    assert.equal(trafficSignalBrakeFactor({
        vehicleX: 0,
        vehicleZ: 0,
        heading: 0,
        signal,
        elapsedSeconds: 5,
    }), 1, 'green does not brake');
});
