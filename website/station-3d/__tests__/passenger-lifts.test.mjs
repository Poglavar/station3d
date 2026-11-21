import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { localToGeo } from '../core/math.js';
import {
    createPassengerLiftRide,
    registerModelLifts,
    unregisterModelLifts,
} from '../world/lifts.js';

const anchor = { lat: 45.8, lon: 16.0 };
const stops = [
    { id: 'street', y: 0, landing: { x: 0, z: 0 } },
    { id: 'deck', y: 20, landing: { x: 0, z: 0 } },
];

function rootAt(y = 0, id = 'tower-lift') {
    const root = new THREE.Group();
    root.position.y = y;
    const cabin = new THREE.Group();
    const doors = [{ object: new THREE.Object3D(), closedX: -1, openX: -2 }];
    root.userData.lifts = [{ id, stops, cabin, doors }];
    root.add(cabin);
    return { root, lift: root.userData.lifts[0] };
}

function walkerAt(root, y = 0) {
    const p = root.localToWorld(new THREE.Vector3(0, y, 0));
    return { ...localToGeo(p.x, p.z, anchor.lon, anchor.lat), y: p.y, yaw: 0 };
}

test('walker follows cabin height and doors open only at landings', async () => {
    const { root, lift } = rootAt();
    registerModelLifts(root);
    const walker = walkerAt(root, 0);
    const ride = createPassengerLiftRide({ liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10, walker, anchorLat: anchor.lat, anchorLon: anchor.lon });
    ride.step(3.5);
    assert.equal(ride.snapshot.phase, 'traveling');
    assert.equal(lift.cabin.position.y, ride.snapshot.floorY);
    assert.equal(walker.y, ride.snapshot.floorY);
    assert.equal(ride.snapshot.doorOpen, 0);
    ride.step(3.5);
    assert.ok(ride.snapshot.phase === 'arrival-opening' || ride.snapshot.phase === 'exiting');
    assert.ok(ride.snapshot.doorOpen > 0);
    assert.equal(lift.cabin.position.y, 20);
    ride.step(99);
    assert.equal(ride.snapshot.done, true);
    assert.equal(walker.y, 20);
    assert.equal(ride.snapshot.doorOpen, 1);
    assert.equal(await ride.completed, true);
    unregisterModelLifts(root);
});

test('lift sound cues fire once per phase and never replay after completion or cancel', async () => {
    const { root } = rootAt();
    registerModelLifts(root);
    const cues = [];
    const ride = createPassengerLiftRide({
        liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10,
        walker: walkerAt(root, 0), anchorLat: anchor.lat, anchorLon: anchor.lon,
        onSoundCue: (cue, phase) => cues.push({ cue, phase }),
    });
    for (let i = 0; i < 200 && !ride.snapshot.done; i += 1) ride.step(0.1);
    assert.equal(ride.snapshot.done, true);
    assert.deepEqual(cues, [
        { cue: 'door-slide', phase: 'opening' },
        { cue: 'door-slide', phase: 'closing' },
        { cue: 'arrival-chime', phase: 'arrival-opening' },
    ]);
    ride.step(10);
    assert.equal(cues.length, 3);
    ride.cancel();
    assert.equal(cues.length, 3);
    unregisterModelLifts(root);

    const second = rootAt();
    registerModelLifts(second.root);
    const cancelledCues = [];
    const cancelled = createPassengerLiftRide({
        liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10,
        walker: walkerAt(second.root, 0), anchorLat: anchor.lat, anchorLon: anchor.lon,
        onSoundCue: (cue, phase) => cancelledCues.push({ cue, phase }),
    });
    cancelled.step(0.1);
    cancelled.cancel();
    cancelled.step(10);
    assert.deepEqual(cancelledCues, [{ cue: 'door-slide', phase: 'opening' }]);
    unregisterModelLifts(second.root);
});

test('ascent and replacement root keep the passenger attached to the live cabin', () => {
    const first = rootAt();
    registerModelLifts(first.root);
    const walker = walkerAt(first.root, 0);
    const ride = createPassengerLiftRide({ liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10, walker, anchorLat: anchor.lat, anchorLon: anchor.lon });
    ride.step(3.5);
    const replacement = rootAt(5);
    registerModelLifts(replacement.root);
    unregisterModelLifts(first.root);
    ride.step(1);
    assert.equal(replacement.lift.cabin.position.y, ride.snapshot.floorY);
    assert.equal(walker.y, replacement.root.position.y + ride.snapshot.floorY);
    ride.cancel();
    assert.equal(walker.y, replacement.root.position.y);
    assert.equal(ride.snapshot.done, false);
    unregisterModelLifts(replacement.root);
});

test('cancel resolves false and restores the originating landing', async () => {
    const { root } = rootAt();
    registerModelLifts(root);
    const walker = walkerAt(root, 0);
    const ride = createPassengerLiftRide({ liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10, walker, anchorLat: anchor.lat, anchorLon: anchor.lon });
    ride.step(5);
    ride.cancel();
    assert.equal(walker.y, 0);
    assert.equal(await ride.completed, false);
    unregisterModelLifts(root);
});

test('closed landing gates stop entry into an absent cabin; open gates and cabin support follow its floor', async () => {
    const { liftFloorYAt, resolveLiftLandingMove } = await import('../world/lifts.js');
    const { root, lift } = rootAt();
    lift.widthM = 3;
    lift.depthM = 2;
    lift.cabin.position.y = 20;
    registerModelLifts(root);
    assert.deepEqual(resolveLiftLandingMove(0, 2, 0, 0, 0), { x: 0, z: 2 });
    assert.equal(liftFloorYAt(0, 0, 0), null);
    assert.equal(liftFloorYAt(0, 0, 20), 20);
    assert.equal(liftFloorYAt(4, 0, 20), null);
    assert.equal(liftFloorYAt(4, 0, Infinity), null);
    assert.equal(liftFloorYAt(0, 0, Infinity), 20);
    lift.cabin.position.y = 0;
    lift.doors[0].object.position.x = lift.doors[0].openX;
    assert.deepEqual(resolveLiftLandingMove(0, 2, 0, 0, 0), { x: 0, z: 0 });
    assert.equal(liftFloorYAt(0, 0, 0), 0);
    unregisterModelLifts(root);
});

test('free roam finds only the reachable landing at the player elevation', async () => {
    const { nearestLiftLanding } = await import('../world/lifts.js');
    const { root } = rootAt(7, 'free-lift');
    root.position.x = 10;
    registerModelLifts(root);
    const landing = nearestLiftLanding(10, 0, 27);
    assert.equal(landing.fromStop, 'deck');
    assert.deepEqual(landing.stops, [{ id: 'street', y: 0 }]);
    assert.equal(nearestLiftLanding(10, 0, 15), null);
    assert.equal(nearestLiftLanding(20, 0, 27), null);
    unregisterModelLifts(root);
    assert.equal(nearestLiftLanding(10, 0, 27), null);
});

test('opposite-side cabin and landing doors open only for the active stop', async () => {
    const { resolveLiftLandingMove } = await import('../world/lifts.js');
    const { root, lift } = rootAt();
    lift.widthM = 3;
    lift.depthM = 2;
    lift.stops = [
        { id: 'street', y: 0, landing: { x: 0, z: -2 }, doorNormal: { x: 0, z: -1 } },
        { id: 'deck', y: 20, landing: { x: 0, z: 2 }, doorNormal: { x: 0, z: 1 } },
    ];
    lift.doors = lift.stops.map(stop => ({ object: new THREE.Object3D(), closedX: 0, openX: 1, stopId: stop.id }));
    lift.stops.forEach((stop, i) => { stop.doors = [lift.doors[i]]; });
    registerModelLifts(root);
    assert.deepEqual(resolveLiftLandingMove(0, -2, 0, 0, 0), { x: 0, z: -2 }, 'north gate blocks entry');
    const walker = walkerAt(root, 0);
    const ride = createPassengerLiftRide({ liftId: 'tower-lift', fromStop: 'street', toStop: 'deck', speedMps: 10, walker, anchorLat: anchor.lat, anchorLon: anchor.lon, onSoundCue: () => {} });
    ride.step(1.1);
    assert.equal(lift.doors[0].object.position.x, 1);
    assert.equal(lift.doors[1].object.position.x, 0);
    assert.deepEqual(resolveLiftLandingMove(0, -2, 0, 0, 0), { x: 0, z: 0 });
    ride.step(99);
    assert.equal(lift.doors[0].object.position.x, 0);
    assert.equal(lift.doors[1].object.position.x, 1);
    assert.equal(await ride.completed, true);
    unregisterModelLifts(root);
});
