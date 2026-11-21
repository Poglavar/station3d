// Verifies that free-roam entry points select explicit, independently overridable capabilities.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    enabledVehicleControllerKinds,
    FREE_ROAM_PRESETS,
    hasEnterableVehicleCapability,
    resolveFreeRoamPreset,
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { createCabState } from '../state.js';

test('quiet walk keeps base-world rail infrastructure without GTA systems', () => {
    const { capabilities } = resolveFreeRoamPreset('walk');
    assert.deepEqual(enabledVehicleControllerKinds(capabilities), []);
    assert.equal(hasEnterableVehicleCapability(capabilities), false);
    for (const capability of Object.values(SESSION_CAPABILITY)) {
        assert.equal(
            sessionCapabilityEnabled(capabilities, capability),
            capability === SESSION_CAPABILITY.CROATIA_RAIL_STREAMING,
        );
    }
});

test('GTA enables each interactive free-roam system explicitly', () => {
    const { capabilities } = resolveFreeRoamPreset('gta');
    assert.deepEqual(enabledVehicleControllerKinds(capabilities), ['road', 'boat', 'aircraft']);
    assert.equal(hasEnterableVehicleCapability(capabilities), true);
    for (const capability of Object.values(SESSION_CAPABILITY)) {
        assert.equal(sessionCapabilityEnabled(capabilities, capability), true);
    }
});

test('capabilities can be narrowed without mutating the shared preset', () => {
    const narrowed = resolveFreeRoamPreset('gta', {
        boats: false,
        aircraft: false,
        ambientTrams: false,
        ignoredSetting: true,
    });
    assert.deepEqual(enabledVehicleControllerKinds(narrowed.capabilities), ['road']);
    assert.equal(hasEnterableVehicleCapability(narrowed.capabilities), true);
    assert.equal(narrowed.capabilities.ignoredSetting, undefined);
    assert.equal(FREE_ROAM_PRESETS.gta.capabilities.boats, true);
    assert.ok(Object.isFrozen(narrowed.capabilities));
});

test('unknown free-roam presets fail safely to quiet walk', () => {
    assert.equal(resolveFreeRoamPreset('unknown').id, 'walk');
    assert.equal(hasEnterableVehicleCapability(resolveFreeRoamPreset('unknown').capabilities), false);
});

test('cab state carries the selected preset and immutable capability object', () => {
    const preset = resolveFreeRoamPreset('gta');
    const cabState = createCabState({ lat: 45.8, lon: 15.98 }, {
        sessionPresetId: preset.id,
        sessionCapabilities: preset.capabilities,
    });
    assert.equal(cabState.sessionPresetId, 'gta');
    assert.equal(cabState.sessionCapabilities, preset.capabilities);
    assert.equal(cabState.gtaMode, undefined);
});

test('session layers consume named capabilities rather than a shared GTA switch', () => {
    const sources = [
        '../modes/cab.js',
        '../world/cars.js',
        '../world/decor.js',
        '../world/gta-special-vehicles.js',
        '../world/rails.js',
        '../vehicles/tram.js',
    ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
    const joined = sources.join('\n');
    assert.doesNotMatch(joined, /cabState\.gtaMode|isGtaModeFn|\bisGtaMode\b/);
    for (const name of [
        'BOATS',
        'AIRCRAFT',
        'AMBIENT_TRAMS',
        'CROATIA_RAIL_STREAMING',
        'PARKED_VEHICLES',
        'TRAFFIC_LIGHTS',
        'AMBIENT_PEDESTRIANS',
        'CONTINUOUS_STREAMING',
        'RENDER_ORIGIN_REBASING',
        'EXPANDED_BUILDING_STREAMING',
        'CROATIA_BOUNDS',
        'SUPPRESS_TRAFFIC_WRECK_DRESSING',
    ]) {
        assert.match(joined, new RegExp(`SESSION_CAPABILITY\\.${name}`));
    }
    assert.match(sources[0], /resolveFreeRoamPreset\(presetId, options\?\.sessionCapabilities\)/);
    assert.match(sources[0], /enabledControllerKinds: vehicleControllerKinds/);
    assert.match(sources[1], /suppressTrafficWreckDressing/);
});
