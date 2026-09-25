// Which sessions get the DGU terrain. Zagreb's walk and tram sessions show it by default
// (the rollout opt-in ended 2026-09-25): on the flat world an authored landmark's parts
// each land on the ground plane, so a stadium roof ends up below its own stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveTerrainSessionPolicy,
    terrainRequested,
    TERRAIN_SESSION_POLICY,
} from '../core/terrain-request.js';
import { LOCATIONS } from '../core/locations.js';

function requested(search, location, sessionPresetId = '') {
    const params = new URLSearchParams(search);
    const sessionPolicy = resolveTerrainSessionPolicy(params, { sessionPresetId, location });
    return terrainRequested(params, {
        locationHasTerrain: !!location?.terrain,
        locationOptIn: !!location?.terrainOptIn,
        sessionPolicy,
    });
}

test('Zagreb walk and tram sessions show the terrain without a flag', () => {
    const zagreb = LOCATIONS.zagreb;
    assert.ok(zagreb.terrain, 'Zagreb ships a terrain source');
    assert.equal(zagreb.terrainOptIn, undefined);
    assert.equal(resolveTerrainSessionPolicy(new URLSearchParams('st3d=walk'), { location: zagreb }),
        TERRAIN_SESSION_POLICY.LOCATION_DEFAULT);
    assert.equal(requested('st3d=walk&lat=45.8179&lon=16.0163', zagreb), true);
    assert.equal(requested('st3d=cab&line=4', zagreb), true);
    assert.equal(requested('', zagreb), true);
});

test('?elevation=0 and photo worlds still open without the DGU surface', () => {
    const zagreb = LOCATIONS.zagreb;
    assert.equal(requested('st3d=walk&elevation=0', zagreb), false);
    assert.equal(requested('st3d=walk&elevation=off', zagreb), false);
    assert.equal(requested('st3d=walk&photo', zagreb), false);
    assert.equal(requested('st3d=gta&elevation=0', zagreb), false);
});

test('a location that declares terrainOptIn stays flat until asked', () => {
    const tuning = { id: 'tuning-town', terrain: {}, terrainOptIn: true };
    assert.equal(resolveTerrainSessionPolicy(new URLSearchParams('st3d=walk'), { location: tuning }),
        TERRAIN_SESSION_POLICY.OPT_IN);
    assert.equal(requested('st3d=walk', tuning), false);
    assert.equal(requested('st3d=walk&elevation=1', tuning), true);
    assert.equal(requested('st3d=walk&project=12', tuning), true);
    assert.equal(requested('st3d=gta', tuning, 'gta'), true, 'GTA always needs the real datum');
});

test('a location without terrain only tries when a flag asks', () => {
    const flat = { id: 'flatland' };
    assert.equal(requested('st3d=walk', flat), false);
    assert.equal(requested('st3d=walk&elevation=1', flat), true);
});
