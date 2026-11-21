// Vehicle publication keeps its bounded cadence while loading freezes motion.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../world/gta-special-vehicles.js', import.meta.url), 'utf8');
function layerHarness() {
    let clockMs = 0, waterPublished = false, boats = 0, scans = 0, crashAdvances = 0;
    const context = vm.createContext({
        enabled: true, specialVehiclesGroup: {}, boatsEnabled: true, aircraftEnabled: false,
        mooringShaderStartup: null, mooringShaderWarmup: { ready: true },
        nextSpawnCheckMs: 0, spawnCheckElapsed: .75, SPAWN_CHECK_SECONDS: .75,
        performance: { now: () => clockMs },
        retireDistantVehicles() {}, refreshUnclaimedTerrainPlacements() {},
        stepAutonomousAircraft() {},
        // Render-time propeller idling and its clock live beside the cadence
        // gate; the harness only asserts the gate.
        lastRenderNowMs: 0, spinIdleAircraftPropellers() {},
        advanceAircraftCrashEffects() { crashAdvances++; },
        ensureBoats() { scans++; if (waterPublished) boats = 1; },
    });
    vm.runInContext(source.slice(source.indexOf('export const gtaSpecialVehiclesLayer'))
        .replace('export const gtaSpecialVehiclesLayer', 'var layer'), context);
    return { layer: context.layer, advance: value => { clockMs = value; },
        publishWater: () => { waterPublished = true; },
        result: () => ({ boats, scans, crashAdvances }) };
}

test('late water can publish the initial boat while loading keeps simulation dt zero', () => {
    const h = layerHarness();
    h.layer.onFrame({}, { x: 0, z: 0 }, 0);
    assert.deepEqual(h.result(), { boats: 0, scans: 1, crashAdvances: 1 });
    h.publishWater();
    h.advance(750);
    h.layer.onFrame({}, { x: 0, z: 0 }, 0);
    assert.deepEqual(h.result(), { boats: 1, scans: 2, crashAdvances: 2 });
    // Render-only crash settlement receives the same paused frames, while the
    // 750 ms publication gate remains unchanged.
});

test('render frames cannot turn the publication scan into per-frame work', () => {
    const h = layerHarness();
    for (let i = 0; i < 75; i++) {
        h.advance(i * 10);
        h.layer.onFrame({}, { x: 0, z: 0 }, 1);
    }
    assert.equal(h.result().scans, 1);
    assert.equal(h.result().crashAdvances, 75);
    h.advance(750);
    h.layer.onFrame({}, { x: 0, z: 0 }, 0);
    assert.equal(h.result().scans, 2);
    assert.equal(h.result().crashAdvances, 76);
});
