// Covers ambient tram reservation, claim, exit dwell and streamed-path resume.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AMBIENT_TRAIN_CRUISE,
    AMBIENT_TRAIN_POLICY,
    AMBIENT_TRAIN_SERVICE_PHASES,
    createAmbientTramProvider,
} from '../core/ambient-tram-provider.js';

const pathA = {
    id: 'osm:10',
    osmId: 10,
    points: [{ x: 0, z: 0, lon: 15, lat: 45 }, { x: 100, z: 0, lon: 15.001, lat: 45 }],
    cumulativeM: [0, 100],
    lengthM: 100,
    centerX: 50,
    centerZ: 0,
};
const pathB = {
    id: 'osm:20',
    osmId: 20,
    points: [{ x: 40, z: 0, lon: 15.0004, lat: 45 }, { x: 40, z: 100, lon: 15.0004, lat: 44.999 }],
    cumulativeM: [0, 100],
    lengthM: 100,
    centerX: 40,
    centerZ: 50,
};

const oneWayPath = {
    ...pathA,
    id: 'osm:one-way',
    osmId: 'one-way',
    travelDirection: 1,
};

function fixture() {
    let now = 1_000;
    const provider = createAmbientTramProvider({ nowMs: () => now });
    provider.replacePaths([pathA], { maxTrams: 1 });
    provider.step(0, { x: 50, z: 0 }, now);
    const record = provider.snapshot()[0];
    record.distanceM = 10;
    return {
        provider,
        setNow(value) { now = value; },
        get now() { return now; },
    };
}

test('first press requests a stop, doors interlock, and second close press claims', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.snapshot()[0].lastPose;
    assert.equal(provider.requestBoarding(id, pose, now), true);
    assert.equal(provider.get(id).state, 'boarding-requested');
    assert.equal(provider.claim(id, pose), null, 'moving tram cannot be claimed');
    for (let index = 0; index < 120; index += 1) provider.step(0.1, pose, now + index * 100);
    assert.ok(provider.get(id).currentSpeedMps <= 0.4);
    assert.ok(provider.get(id).doorRatio >= 0.95);
    assert.ok(provider.claim(id, provider.get(id).lastPose));
    assert.equal(provider.get(id).state, 'controlling');
});

test('reservation cancels on timeout or excessive player distance', () => {
    const timed = fixture();
    const id = timed.provider.snapshot()[0].id;
    const pose = timed.provider.get(id).lastPose;
    timed.provider.requestBoarding(id, pose, timed.now);
    timed.provider.step(0.1, pose, timed.now + 30_001);
    assert.equal(timed.provider.get(id).state, 'autonomous');

    timed.provider.requestBoarding(id, timed.provider.get(id).lastPose, timed.now + 31_000);
    timed.provider.step(0.1, { x: 999, z: 999 }, timed.now + 31_100);
    assert.equal(timed.provider.get(id).state, 'autonomous');
});

test('claimed trams are not autonomously advanced, culled or duplicated', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.get(id).lastPose;
    provider.get(id).currentSpeedMps = 0;
    provider.get(id).doorRatio = 1;
    provider.requestBoarding(id, pose, now);
    const claimed = provider.claim(id, pose);
    assert.ok(claimed);
    provider.sync(id, { ...pose, x: 42, speedMps: 3 });
    provider.step(1, { x: 42, z: 0 }, now + 1_000);
    provider.replacePaths([pathA], { centerX: 90, maxTrams: 1 });
    assert.equal(provider.snapshot().filter(record => record.id === id).length, 1);
    assert.equal(provider.get(id).lastPose.x, 42);
});

test('release dwells two seconds and resumes on the current source edge', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.get(id).lastPose;
    provider.get(id).currentSpeedMps = 0;
    provider.get(id).doorRatio = 1;
    provider.requestBoarding(id, pose, now);
    provider.claim(id, pose);
    provider.replacePaths([pathA, pathB], { maxTrams: 2 });
    provider.sync(id, { x: 40, z: 55, lon: 15.0004, lat: 44.99945, headingDeg: 180, speedMps: 0 });
    provider.release(id, provider.get(id).lastPose, { sourceOsmId: 20, cruiseSpeedMps: 9 }, now);
    provider.step(0.1, { x: 40, z: 55 }, now + 1_999);
    assert.equal(provider.get(id).state, 'exiting');
    for (let index = 0; index < 12; index += 1) {
        provider.step(0.1, { x: 40, z: 55 }, now + 2_000 + index * 100);
    }
    assert.equal(provider.get(id).pathId, 'osm:20');
    assert.equal(provider.get(id).state, 'autonomous');
    assert.ok(provider.get(id).distanceM > 50 && provider.get(id).distanceM < 60);
});

test('missing release path leaves the tram stopped until that source revision arrives', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.get(id).lastPose;
    provider.get(id).currentSpeedMps = 0;
    provider.get(id).doorRatio = 1;
    provider.requestBoarding(id, pose, now);
    provider.claim(id, pose);
    provider.sync(id, { x: 40, z: 55, lon: 15.0004, lat: 44.99945, headingDeg: 180, speedMps: 0 });
    provider.release(id, provider.get(id).lastPose, { sourceOsmId: 20 }, now);
    for (let index = 0; index < 12; index += 1) {
        provider.step(0.1, { x: 40, z: 55 }, now + 2_000 + index * 100);
    }
    assert.equal(provider.get(id).state, 'waiting-for-path');
    assert.equal(provider.get(id).currentSpeedMps, 0);
    provider.replacePaths([pathA, pathB], { maxTrams: 2 });
    assert.equal(provider.get(id).state, 'autonomous');
    assert.equal(provider.get(id).pathId, 'osm:20');
});

test('destruction invalidates a reservation and removes the tram from selection', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.get(id).lastPose;
    assert.equal(provider.requestBoarding(id, pose, now), true);
    assert.equal(provider.destroy(id), true);
    assert.equal(provider.get(id).state, 'destroyed');
    assert.equal(provider.findNearest(pose), null);
    assert.equal(provider.claim(id, pose), null);
});

test('release enforces safe exit speed unless teardown explicitly forces it', () => {
    const { provider, now } = fixture();
    const id = provider.snapshot()[0].id;
    const pose = provider.get(id).lastPose;
    provider.get(id).currentSpeedMps = 0;
    provider.get(id).doorRatio = 1;
    provider.requestBoarding(id, pose, now);
    provider.claim(id, pose);
    assert.equal(provider.release(id, { ...pose, speedMps: 1 }, {}, now), false);
    assert.equal(provider.get(id).state, 'controlling');
    assert.equal(provider.release(id, { ...pose, speedMps: 1 }, { force: true }, now), true);
});

test('provider keeps OSM one-way trams on the authored running side', () => {
    const provider = createAmbientTramProvider({ nowMs: () => 1_000 });
    provider.replacePaths([oneWayPath], { maxTrams: 1 });
    const record = provider.snapshot()[0];
    provider.get(record.id).distanceM = oneWayPath.lengthM - 0.1;
    provider.get(record.id).direction = -1;
    provider.step(0.1, { x: 50, z: 0 }, 1_100);
    assert.equal(provider.get(record.id).direction, 1);
    assert.ok(provider.get(record.id).distanceM < 2);
});

test('a train provider hails and boards like a tram but names itself a train, and resumes on any way of a chained run', () => {
    let now = 0;
    const provider = createAmbientTramProvider({
        nowMs: () => now, id: 'trains', kind: 'train', idPrefix: 'gta-train', policy: AMBIENT_TRAIN_POLICY, ...AMBIENT_TRAIN_CRUISE,
    });
    const run = {
        id: 'osm:1+2', osmId: 1, osmIds: [1, 2], sourceIds: [1, 2],
        points: [{ x: 0, z: 0, lon: 15, lat: 45, osmId: 1 }, { x: 1000, z: 0, lon: 15.0127, lat: 45, osmId: 1 }, { x: 2000, z: 0, lon: 15.0254, lat: 45, osmId: 2 }],
        cumulativeM: [0, 1000, 2000], lengthM: 2000, centerX: 1000, centerZ: 0, travelDirection: 0,
    };
    const [record] = provider.replacePaths([run], { centerX: 0, centerZ: 0, maxTrams: 2 });
    assert.equal(record.id, 'gta-train:osm:1+2');
    assert.ok(record.cruiseSpeedMps >= 18);
    assert.equal(provider.id, 'trains');
    assert.equal(provider.kind, 'train');
    for (let i = 0; i < 40; i += 1) provider.step(0.1, null, now += 100);
    const pose = provider.snapshot()[0].lastPose;
    const near = { x: pose.x, z: pose.z };
    const candidate = provider.findNearest(near);
    assert.equal(candidate.kind, 'train');
    assert.equal(candidate.controllerId, 'train');
    assert.equal(provider.requestBoarding(candidate.id, near, now), true);
    // The train brakes gently: it takes many seconds and a long way to stop.
    let stopped = null;
    for (let i = 0; i < 400 && stopped === null; i += 1) {
        provider.step(0.1, { x: provider.snapshot()[0].lastPose.x, z: provider.snapshot()[0].lastPose.z }, now += 100);
        if (provider.snapshot()[0].currentSpeedMps <= AMBIENT_TRAIN_POLICY.stoppedMps) stopped = i;
    }
    assert.ok(stopped > 60, `stopped after ${stopped} steps`);
    // The player stands by the door while it opens; walking away would cancel the stop.
    const beside = () => ({ x: provider.snapshot()[0].lastPose.x, z: provider.snapshot()[0].lastPose.z });
    for (let i = 0; i < 20; i += 1) provider.step(0.1, beside(), now += 100);
    const stop = provider.snapshot()[0].lastPose;
    const claimed = provider.claim(candidate.id, { x: stop.x, z: stop.z });
    assert.ok(claimed, 'boarded');
    // Released on the second way of the run: the run still owns that way.
    assert.equal(provider.release(candidate.id, { ...stop, x: 1500, z: 0, speedMps: 0 }, { sourceOsmId: 2 }, now), true);
    for (let i = 0; i < 60; i += 1) provider.step(0.1, null, now += 100);
    assert.equal(provider.snapshot()[0].state, 'autonomous', 'resumed on its run by way id 2');
    assert.equal(provider.snapshot()[0].pathId, 'osm:1+2');
});

test('a station train waits off-world, arrives, dwells with open doors, leaves, and schedules its next visit', () => {
    let now = 0;
    const run = {
        id: 'osm:split', osmId: 'split', osmIds: ['split'], sourceIds: ['split'],
        points: [
            { x: 0, z: 0, lon: 16.443, lat: 43.505, osmId: 'split' },
            { x: 1_500, z: 0, lon: 16.461, lat: 43.505, osmId: 'split' },
        ],
        cumulativeM: [0, 1_500], lengthM: 1_500, centerX: 750, centerZ: 0,
        travelDirection: 0,
    };
    const provider = createAmbientTramProvider({
        nowMs: () => now,
        id: 'trains',
        kind: 'train',
        idPrefix: 'gta-train',
        policy: AMBIENT_TRAIN_POLICY,
        cruiseMinMps: 12,
        cruiseStepMps: 0,
        random: () => 0,
        stationService: {
            stationX: 100,
            stationZ: 0,
            pathSnapToleranceM: 5,
            approachDistanceM: 240,
            clearDistanceM: 300,
            initialWaitMs: [1_000, 1_000],
            dwellMs: [2_000, 2_000],
            intervalMs: [5_000, 5_000],
        },
    });
    const [record] = provider.replacePaths([run], { maxTrams: 2 });
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.WAITING);
    assert.deepEqual(provider.step(0.1, { x: 100, z: 0 }, now), [], 'waiting train is not rendered');
    assert.equal(provider.findNearest({ x: 100, z: 0 }), null, 'waiting train cannot be hailed');

    now = 1_000;
    let poses = provider.step(0.1, { x: 100, z: 0 }, now);
    assert.equal(poses.length, 1);
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.APPROACHING);
    assert.ok(record.distanceM > record.serviceStopDistanceM);
    for (let index = 0; index < 1_000
        && record.servicePhase !== AMBIENT_TRAIN_SERVICE_PHASES.DWELLING; index += 1) {
        now += 100;
        poses = provider.step(0.1, { x: 100, z: 0 }, now);
    }
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.DWELLING);
    assert.ok(Math.abs(record.distanceM - 100) < 0.1);
    for (let index = 0; index < 10; index += 1) {
        now += 100;
        provider.step(0.1, { x: 100, z: 0 }, now);
    }
    assert.ok(record.doorRatio > 0.9, 'doors open during the station call');

    for (let index = 0; index < 1_000
        && record.servicePhase !== AMBIENT_TRAIN_SERVICE_PHASES.WAITING; index += 1) {
        now += 100;
        provider.step(0.1, { x: 100, z: 0 }, now);
    }
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.WAITING);
    assert.equal(record.serviceNextAtMs, now + 5_000);
    assert.deepEqual(provider.step(0.1, { x: 100, z: 0 }, now + 100), []);
});

test('the station service train is the same nearby train claimed by the shared takeover provider', () => {
    let now = 0;
    const provider = createAmbientTramProvider({
        nowMs: () => now,
        id: 'trains', kind: 'train', idPrefix: 'gta-train',
        policy: AMBIENT_TRAIN_POLICY,
        stationService: {
            stationX: 0, stationZ: 0, pathSnapToleranceM: 5,
            approachDistanceM: 20, clearDistanceM: 40,
            initialWaitMs: [0, 0], dwellMs: [60_000, 60_000], intervalMs: [1_000, 1_000],
        },
        random: () => 0,
        cruiseMinMps: 2,
        cruiseStepMps: 0,
    });
    const run = {
        id: 'osm:split-takeover', osmId: 9, osmIds: [9], sourceIds: [9],
        points: [{ x: 0, z: 0, lon: 16.443, lat: 43.505, osmId: 9 }, { x: 1_500, z: 0, lon: 16.46, lat: 43.505, osmId: 9 }],
        cumulativeM: [0, 1_500], lengthM: 1_500, centerX: 750, centerZ: 0, travelDirection: 0,
    };
    const [record] = provider.replacePaths([run], { maxTrams: 2 });
    for (let index = 0; index < 400
        && record.servicePhase !== AMBIENT_TRAIN_SERVICE_PHASES.DWELLING; index += 1) {
        provider.step(0.1, record.lastPose, now += 100);
    }
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.DWELLING);
    for (let index = 0; index < 10; index += 1) provider.step(0.1, record.lastPose, now += 100);
    const near = { x: record.lastPose.x, z: record.lastPose.z };
    const candidate = provider.findNearest(near);
    assert.equal(candidate.id, record.id);
    assert.equal(candidate.ready, true, 'a dwelling train with open doors is ready to board');
    assert.equal(provider.requestBoarding(candidate.id, near, now), true);
    assert.ok(provider.claim(candidate.id, near), 'the station train transfers to player control');
    assert.equal(record.state, 'controlling');
    assert.equal(provider.release(record.id, { ...record.lastPose, speedMps: 0 }, { sourceOsmId: 9 }, now), true);
    for (let index = 0; index < 40; index += 1) provider.step(0.1, near, now += 100);
    assert.equal(record.state, 'autonomous');
    assert.equal(record.servicePhase, AMBIENT_TRAIN_SERVICE_PHASES.DEPARTING);
});
