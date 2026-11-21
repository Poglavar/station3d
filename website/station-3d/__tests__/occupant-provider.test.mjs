// Covers generic occupancy transitions and deterministic provider selection.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    beginExit,
    cancelOccupantTransition,
    completeBoarding,
    completeExit,
    createOccupantState,
    requestBoarding,
    selectSafeExitCandidate,
} from '../core/occupant.js';
import { selectNearestVehicleProvider } from '../core/vehicle-provider.js';

test('exit previews and real exits stop support queries at the first safe landing', () => {
    const visited = [];
    const landing = { x: 3, y: 1, z: 2, supported: true, blocked: false };
    function* candidates() {
        visited.push('water');
        yield { supported: true, blocked: true };
        visited.push('unsupported');
        yield { supported: false, blocked: false };
        visited.push('quay');
        yield landing;
        throw new Error('Unneeded support query after a safe landing');
    }
    assert.equal(selectSafeExitCandidate(candidates()), landing);
    const occupant = createOccupantState();
    requestBoarding(occupant, { id: 'boat' });
    completeBoarding(occupant, { id: 'boat' });
    assert.equal(beginExit(occupant, { speedMps: 0, maxSpeedMps: 0.8, candidates: candidates() }), landing);
    assert.deepEqual(visited, ['water', 'unsupported', 'quay', 'water', 'unsupported', 'quay']);
    assert.equal(occupant.state, 'exiting');
});

test('a moving vehicle does not evaluate exit support candidates', () => {
    const occupant = createOccupantState();
    requestBoarding(occupant, { id: 'boat' });
    completeBoarding(occupant, { id: 'boat' });
    function* candidates() { throw new Error('Moving exit should not query support'); }
    assert.equal(beginExit(occupant, { speedMps: 2, maxSpeedMps: 0.8, candidates: candidates() }), null);
    assert.equal(occupant.lastFailure, 'vehicle-moving');
});

test('generic occupancy supports reservation, claim, safe exit and cancellation', () => {
    const occupant = createOccupantState();
    assert.equal(requestBoarding(occupant, {
        id: 'tram-7', providerId: 'trams', controllerId: 'rail', available: true,
    }), true);
    assert.equal(occupant.state, 'boarding-requested');
    assert.equal(completeBoarding(occupant, { id: 'other' }), false);
    assert.equal(completeBoarding(occupant, { id: 'tram-7' }), true);
    assert.equal(occupant.state, 'controlling');
    assert.equal(beginExit(occupant, {
        speedMps: 1,
        maxSpeedMps: 0.8,
        candidates: [{ supported: true }],
    }), null);
    const exit = beginExit(occupant, {
        speedMps: 0.4,
        maxSpeedMps: 0.8,
        candidates: [{ id: 'right', supported: true, blocked: false }],
    });
    assert.equal(exit.id, 'right');
    assert.equal(completeExit(occupant), true);
    assert.equal(occupant.state, 'on-foot');

    requestBoarding(occupant, { id: 'car', available: true });
    assert.equal(cancelOccupantTransition(occupant), true);
    assert.equal(occupant.state, 'on-foot');
});

test('nearest provider wins independent of registration order', () => {
    const far = { id: 'cars', findNearest: () => ({ id: 'car', distanceM: 6 }) };
    const near = { id: 'trams', findNearest: () => ({ id: 'tram', distanceM: 3 }) };
    assert.equal(selectNearestVehicleProvider([far, near], { x: 0, z: 0 }).id, 'tram');
    assert.equal(selectNearestVehicleProvider([near, far], { x: 0, z: 0 }).id, 'tram');
    assert.equal(selectNearestVehicleProvider([near], { x: 0, z: 0 }, 2), null);
});

test('ordinary boarding rejects an unreachable vehicle', () => {
    const occupant = createOccupantState();
    assert.equal(requestBoarding(occupant, {
        id: 'boat', available: true, reachable: false,
    }), false);
    assert.equal(occupant.state, 'on-foot');
    assert.equal(occupant.lastFailure, 'vehicle-unreachable');
});

test('provider selection compares already-probed candidates without probing twice', () => {
    let probes = 0;
    const provider = {
        id: 'cached',
        findNearest() {
            probes += 1;
            return { id: 'unexpected', distanceM: 1 };
        },
    };
    const selected = selectNearestVehicleProvider([{
        provider,
        candidate: { id: 'cached-vehicle', distanceM: 4 },
    }], { x: 0, z: 0 });
    assert.equal(probes, 0);
    assert.equal(selected.id, 'cached-vehicle');
});
