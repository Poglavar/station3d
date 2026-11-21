// Retry retires encounter ownership and retries blocked placements within a fixed bound.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../world/cars.js', import.meta.url), 'utf8');

test('stopping a pursuit removes its cars and bullets without retaining ghost traffic or touching other cars', () => {
    const removed = [], disposed = [];
    const makeCar = (id, encounterId, enemy = true) => ({ id, encounterId, enemy, mesh: { parent: { remove: () => removed.push(id) } } });
    const old = makeCar('old', 'chase', false), active = makeCar('active', 'chase');
    const ambient = makeCar('ambient', null), other = makeCar('other', 'different');
    const sandbox = { globalCars: [old, active, ambient, other], wreckedCars: [makeCar('wreck', 'chase')],
        liveEnemyBullets: [old, ambient].map(owner => ({ owner, mesh: { parent: { remove: () => removed.push('bullet:' + owner.id) } } })),
        disposeCarRuntimeResources: car => disposed.push(car.id) };
    runInNewContext(source.slice(source.indexOf('export function stopCampaignEnemyEncounter('), source.indexOf('export function getCarGraphDebugNodeNear(')).replace('export function', 'function'), sandbox);
    assert.equal(sandbox.stopCampaignEnemyEncounter('chase'), 3);
    assert.deepEqual(sandbox.globalCars.map(car => car.id), ['ambient', 'other']);
    assert.deepEqual(disposed, ['active', 'old', 'wreck']);
    assert.equal(sandbox.wreckedCars.length, 0);
    assert.deepEqual(sandbox.liveEnemyBullets.map(b => b.owner.id), ['ambient']);
    assert.equal(sandbox.stopCampaignEnemyEncounter('chase'), 0);
});

function waveHarness(blockedAttempts) {
    let attempts = 0;
    const segment = { x0: 0, x1: 20, z0: 0, z1: 0, dx: 1, dz: 0, startKey: 'a', endKey: 'b', speed: 10 };
    const sandbox = { Math, Number, performance: { now: () => 0 }, carsGroup: { add() {} },
        globalGraph: { segments: [segment], nodes: new Map([['a', { out: [{ segIdx: 0, forward: true }] }]]) },
        globalCars: [], MAX_TOTAL_CARS: 160, MAX_ENEMY_VEHICLES: 9, nextTrafficCarId: 1,
        isGameModeFn: () => true, countEnemyCars: () => 0, trafficSpawnOccupants: () => [],
        trafficKeepClearVolumes: [], plannerOpenCutVolumes: [], pointInsideKeepClear: () => false,
        isPointInsideCorridorFootprints: () => false, chooseLaneStateForSegment: () => ({ offset: 2, rank: 0 }),
        pickEnemyType: () => ({ paintHex: 1 }), trafficSpawnCandidate: (x, z) => ({ x, z }),
        trafficSpawnHasClearance: () => ++attempts > blockedAttempts,
        buildTrafficVehicleMesh: () => ({}), maxHealthForCarType: () => 100,
        getEnemyMusicTrackCount: () => 1, pickAndCacheNext() {}, placeCarOnTerrain() {},
    };
    runInNewContext(source.slice(source.indexOf('export function spawnEnemyWaveNear('), source.indexOf('function snapshotEncounterRoute(')).replace('export function', 'function'), sandbox);
    return { sandbox, attempts: () => attempts };
}

test('blocked placements do not consume the required wave count', () => {
    const { sandbox, attempts } = waveHarness(6);
    assert.equal(sandbox.spawnEnemyWaveNear(0, 0, 260, 4, { encounterId: 'chase' }), 4);
    assert.equal(attempts(), 10); assert.equal(sandbox.globalCars.length, 4);
    assert.ok(sandbox.globalCars.every(car => car.enemy && car.encounterId === 'chase'));
});

test('a completely blocked area returns failure after bounded work', () => {
    const { sandbox, attempts } = waveHarness(Infinity);
    const diagnostics = {};
    assert.equal(sandbox.spawnEnemyWaveNear(0, 0, 260, 4, { encounterId: 'chase', diagnostics }), 0);
    assert.equal(diagnostics.stopReason, 'attempt-limit');
    assert.equal(diagnostics.rejected.occupied, 96);
    assert.equal(diagnostics.attempts, 96);
    assert.equal(attempts(), 96); assert.equal(sandbox.globalCars.length, 0);
});

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
test('an unplaceable campaign wave fails visibly and releases encounter game mode', async () => {
    const messages = [], stopped = [], pursuit = [];
    const cabState = { layerStartup: { start: async () => true }, gameMode: 'explore', lastRenderedPose: { lat: 45, lon: 16 } };
    const sandbox = { carsLayer: {}, surfaceLayerEntries: [], waitForTrafficRoadsNear: async () => true, state: { cabState }, geoToLocal: () => ({ x: 0, z: 0 }),
        console: { warn: (...args) => messages.push(args) },
        setCabGameMode: (cab, mode) => { cab.gameMode = mode; },
        spawnEnemyWaveNear: (_x, _z, _r, _n, { diagnostics }) => {
            diagnostics.stopReason = 'no-nearby-roads'; return 0;
        },
        stopCampaignEnemyEncounter: id => stopped.push(id),
        beginEncounterPursuit: spec => pursuit.push(['begin', spec.encounterId]),
        endEncounterPursuit: () => pursuit.push(['end']),
        startCampaignFootPursuit: () => pursuit.push(['foot']),
        stopCampaignFootPursuit: () => pursuit.push(['foot-end']),
    };
    runInNewContext(cabSource.slice(cabSource.indexOf('export async function startCabCampaignEncounter('),
        cabSource.indexOf('export function closeCab(')).replaceAll('export ', ''), sandbox);
    assert.equal(await sandbox.startCabCampaignEncounter({ id: 'chase', pursuerCount: 4 }), false);
    assert.equal(cabState.campaignEncounterId, null);
    assert.equal(cabState.gameMode, 'explore');
    assert.deepEqual(stopped, ['chase']);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][1].placement.stopReason, 'no-nearby-roads');
    // A wave that never reached the streets must not leave a pursuit running:
    // it would keep trying to reinforce an encounter that does not exist.
    assert.deepEqual(pursuit, [['end'], ['foot-end']], 'no chase, on wheels or on foot, is declared for an unplaceable wave');
});


test('traffic readiness resolves on nearby graph publication and releases its waiters', async () => {
    const sandbox = { Math, Promise, setTimeout, clearTimeout,
        globalGraph: { segments: [] }, trafficRoadReadinessWaiters: new Set() };
    runInNewContext(source.slice(source.indexOf('export function waitForTrafficRoadsNear('),
        source.indexOf('// Force-spawn a wave')).replace('export ', ''), sandbox);
    const ready = sandbox.waitForTrafficRoadsNear(0, 0, 30);
    assert.equal(sandbox.trafficRoadReadinessWaiters.size, 1);
    sandbox.globalGraph.segments.push({ x0: 1, x1: 2, z0: 0, z1: 0 });
    for (const waiter of sandbox.trafficRoadReadinessWaiters) waiter.check();
    assert.equal(await ready, true);
    assert.equal(sandbox.trafficRoadReadinessWaiters.size, 0);
    assert.equal(await sandbox.waitForTrafficRoadsNear(0, 0, 30), true);
    assert.equal(await sandbox.waitForTrafficRoadsNear(100, 100, 1, { timeoutMs: 5 }), false);
    assert.equal(sandbox.trafficRoadReadinessWaiters.size, 0);
    const cancelled = sandbox.waitForTrafficRoadsNear(100, 100, 1);
    for (const waiter of sandbox.trafficRoadReadinessWaiters) waiter.finish(false);
    assert.equal(await cancelled, false);
});
