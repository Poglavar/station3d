// A forced exit must transfer pose, input and presentation before retiring the vehicle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { forceOccupantOnFoot, placeWalkerAtVehicleExit, selectSafeExitCandidate } from '../core/occupant.js';
import { createControllerRouter } from '../core/controller-router.js';

const gta = await readFile(new URL('../modes/gta.js', import.meta.url), 'utf8');
const cab = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
function harness({ safe = true } = {}) {
    const walker = { lat: 1, lon: 2, y: 10, yaw: 0, vy: -4, airborne: true, initialGroundY: 10, floorGuardActive: true };
    const occupant = { state: 'controlling', vehicleId: 'car', controllerId: 'road' };
    const router = createControllerRouter();
    const controller = action => ({ activate() {}, deactivate() {}, dispose() {}, handleAction: action,
        step() {}, getCameraProfile() {}, requestStop() {}, getExitState() {} });
    router.register('road', controller(() => false));
    router.register('foot', controller(() => { walker.lat += .001; return true; }));
    router.activate('road');
    const events = [];
    const session = { walkMode: walker, occupant, controllerRouter: router, campaignScene: { authored: { vehicleSpawns: ['car'] } },
        lastRenderedPose: { status: { driving: true, speedKmh: 22, vehicleHealth: 84 } }, probeSpeedKmh: 22 };
    const sandbox = { Math, Number, placeWalkerAtVehicleExit, selectSafeExitCandidate, forceOccupantOnFoot,
        controlled: { id: 'car', kind: 'road' }, occupant, lastPose: { speedKmh: 22 },
        currentVehiclePose: () => ({ x: 100, z: 200, y: 3, heading: .6 }),
        evaluatedExitCandidates: () => safe ? [{ x: 103, z: 200, y: 3, supported: true }] : [],
        localToGeo: (x, z) => ({ lat: z, lon: x }), anchorLon: 0, anchorLat: 0,
        releaseControlledParkedCar: () => events.push('release'), removeControlledPhysics: () => events.push('physics'),
        groundMotion: { reset() {} }, controls: { clear() {} }, specialVehicleState: null,
        pendingExitWalkState: null, entryProbe: null, exitPreview: { reset() {} }, stopRequested: false,
        state: { cabState: session }, DEG_TO_RAD: Math.PI / 180, snapshotCabPose: pose => structuredClone(pose),
        walkCameraModeAfterVehicleExit: () => 'third', clearWalkKeys: () => events.push('keys-cleared'),
        resetCameraLook() {}, setWalkControlsMode: mode => events.push(mode), showWalkControls() {},
        resetAuthoredParkedCars() { assert.equal(router.activeId, 'foot'); events.push('fleet'); },
    };
    runInNewContext(gta.slice(gta.indexOf('    function abandonVehicle('), gta.indexOf('    function completePendingExitIfStopped(')), sandbox);
    session.gtaSession = { isDriving: () => !!sandbox.controlled, abandonVehicle: sandbox.abandonVehicle };
    runInNewContext(cab.slice(cab.indexOf('function completeGtaVehicleExit('), cab.indexOf('function toggleGtaVehicle('))
        + cab.slice(cab.indexOf('export function abandonCampaignVehicle('), cab.indexOf('function installVehicleControllers(')).replace('export function', 'function'), sandbox);
    return { sandbox, session, walker, router, occupant, events };
}

test('stuck recovery moves beside the actual car and immediately restores walking input and HUD', () => {
    const { sandbox, session, walker, router, occupant, events } = harness();
    assert.equal(sandbox.abandonCampaignVehicle(), true);
    assert.equal(router.activeId, 'foot'); assert.equal(occupant.state, 'on-foot');
    assert.equal(sandbox.controlled, null); assert.equal(sandbox.lastPose, null);
    assert.equal(walker.lat, 200); assert.equal(walker.lon, 103); assert.equal(walker.y, 3);
    assert.equal(walker.yaw, Math.PI - .6);
    assert.equal(walker.airborne, false); assert.equal(walker.vy, 0); assert.equal(walker.initialGroundY, null);
    assert.equal(walker.floorGuardActive, false); assert.equal(session.probeSpeedKmh, 0);
    assert.equal(session.lastRenderedPose.status.driving, false);
    assert.equal(session.lastRenderedPose.status.vehicleHealth, undefined);
    assert.ok(events.includes('gta-walk')); assert.ok(events.includes('fleet'));
    assert.equal(router.handleAction('move-forward'), true); assert.equal(walker.lat, 200.001);
});

test('destroyed vehicle handoff keeps the wreck and still activates foot controls', () => {
    const { sandbox, router, events } = harness();
    assert.equal(sandbox.abandonCampaignVehicle({ resetFleet: false }), true);
    assert.equal(router.activeId, 'foot'); assert.equal(events.includes('fleet'), false);
});

test('an impossible live exit does not partially release ownership or fake a safe landing', () => {
    const { sandbox, router, walker, occupant, events } = harness({ safe: false });
    assert.equal(sandbox.abandonCampaignVehicle(), false);
    assert.equal(router.activeId, 'road'); assert.equal(occupant.state, 'controlling');
    assert.equal(walker.lat, 1); assert.deepEqual(events, []);
});

test('checkpoint abandonment remains available when the checkpoint owns relocation', () => {
    const { sandbox, walker, occupant } = harness({ safe: false });
    assert.equal(sandbox.abandonVehicle(), true);
    assert.equal(occupant.state, 'on-foot'); assert.equal(walker.lat, 1);
});

test('malformed exit coordinates cannot become an apparently valid zero-altitude landing', () => {
    const walker = { lat: 1, lon: 2, y: 3 };
    assert.equal(placeWalkerAtVehicleExit(walker, { lat: 1, lon: 2, y: null, heading: 0 }), false);
    assert.deepEqual(walker, { lat: 1, lon: 2, y: 3 });
});


test('the public recovery facade returns the completed handoff, not an asynchronous promise', async () => {
    const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const source = index.slice(index.indexOf('function abandonCampaignVehicle('),
        index.indexOf('function failCampaignVehicle('));
    const { sandbox, occupant, router } = harness();
    const facade = { cabMode: sandbox };
    runInNewContext(source, facade);
    assert.equal(facade.abandonCampaignVehicle(), true);
    assert.equal(occupant.state, 'on-foot');
    assert.equal(router.activeId, 'foot');
    assert.equal(facade.abandonCampaignVehicle(), false, 'there is no second vehicle to abandon');
    facade.cabMode = null;
    assert.equal(facade.abandonCampaignVehicle(), false, 'an absent session is not opened for recovery');
});
