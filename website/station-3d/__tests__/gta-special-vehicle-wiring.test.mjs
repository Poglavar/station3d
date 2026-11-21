// Locks the Station3D composition seam that makes data-gated boats and aircraft
// visible, enterable, synchronized, and disposable through the GTA session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
const gtaSource = await readFile(new URL('../modes/gta.js', import.meta.url), 'utf8');
const worldSource = await readFile(new URL('../world/gta-special-vehicles.js', import.meta.url), 'utf8');
const modelSource = await readFile(new URL('../models/vehicles/boat-airplane.js', import.meta.url), 'utf8');
const decorSource = await readFile(new URL('../world/decor.js', import.meta.url), 'utf8');
const waterSource = await readFile(new URL('../world/water.js', import.meta.url), 'utf8');
const physicsSource = await readFile(new URL('../core/gta-special-vehicle.js', import.meta.url), 'utf8');

test('cab composes the special-vehicle layer and provider into GTA', () => {
    assert.match(cabSource, /name: 'gtaSpecialVehicles', layer: gtaSpecialVehiclesLayer/);
    assert.match(cabSource, /specialVehicles: gtaSpecialVehicleProvider/);
});

test('GTA possession branches special motion before Rapier road stepping', () => {
    assert.match(gtaSource, /if \(specialVehicleState && controlled\)/);
    assert.match(gtaSource, /stepGtaSpecialVehicle\(specialVehicleState/);
    assert.match(gtaSource, /specialVehicles\?\.sync\?\.\(controlled\.id, pose\)/);
    assert.match(gtaSource, /specialVehicles\?\.release\?\.\(controlled\.id, pose\)/);
    assert.match(gtaSource, /specialVehicleAudio\.start\(controlled\.kind\)/);
    assert.match(gtaSource, /specialVehicleAudio\.update\(pose\)/);
});

test('world spawning is explicitly mapped-water and runway gated', () => {
    assert.match(worldSource, /isPointInMappedSea\(x, z\) \|\| isPointInDecorWater\(x, z\)/);
    assert.match(worldSource, /getRunwaySpawnCandidatesNear/);
    assert.match(worldSource, /const MAX_BOATS = 5/);
    assert.match(worldSource, /mappedBoatSpawnCandidates\(\[[\s\S]*ZAGREB_BOAT_ANCHORS/);
    assert.match(worldSource, /WATER_LEVELS\.naturalBankTop/);
    assert.match(worldSource, /mappedSeaSurfaceSceneY\(\) \+ 0\.08/);
    assert.match(waterSource, /export function mappedSeaSurfaceSceneY\(\)/);
    assert.match(waterSource, /absoluteToSceneY\?\.\(0\)/);
    assert.match(worldSource, /const MAX_AIRCRAFT = 4/);
    assert.match(worldSource, /const AIRCRAFT_SEARCH_RADIUS_M = GREENERY_RADIUS_M;/, 'aircraft cannot be sought beyond the loaded runways');
    assert.match(decorSource, /export const GREENERY_RADIUS_M = 1100;/);
    assert.match(worldSource, /const side = runwaySide\(candidate, local\.x, local\.z\);\s*for \(const spot of runwayParkingSpots\(candidate, \{ count: AIRCRAFT_PER_RUNWAY, side \}\)\)/);
    assert.match(worldSource, /if \(waterAt\(spot\.x, spot\.z\) \|\| isPointInLoadedRunway\(spot\.x, spot\.z\)\) continue;/);
    assert.match(worldSource, /if \(aircraftCount >= MAX_AIRCRAFT\) return/);
    assert.match(worldSource, /if \(remainingSlots <= 0\) break/);
});

test('sea ownership does not suppress inland boat water in country sessions', () => {
    assert.match(waterSource, /export function isMappedSeaReady\(\)/);
    assert.match(waterSource, /export function hasMappedSeaCoverage\(\)/);
    assert.match(
        decorSource,
        /mappedSeaCoversDecorWaterPolygon\(outerRing, isPointInMappedSea\)/,
    );
    assert.match(
        decorSource,
        /subscribeMappedSeaChanges\(\(\) => \{[\s\S]*refresh\(lastLat, lastLon\)/,
    );
});

test('special vehicle meshes expose bounded propeller and wake effects', () => {
    assert.match(modelSource, /GtaAirplanePropeller/);
    assert.match(modelSource, /root\.userData\.propeller = propeller/);
    assert.match(modelSource, /GtaBoatVHull/);
    assert.match(modelSource, /GtaBoatWake/);
    assert.match(modelSource, /root\.userData\.wake = wake/);
    assert.match(worldSource, /speedRatio/);
});

test('airplane glazing and door graphics use the cabin surface helpers', () => {
    assert.match(modelSource, /buildAirplaneCabinShellGeometryData/);
    assert.match(modelSource, /buildAirplaneCabinSurfaceLinePositions/);
    assert.doesNotMatch(modelSource, /new THREE\.BoxGeometry\(0\.025, 0\.035, 0\.20\)/);
});

test('boats moor along the loaded shoreline, scaled hulls stay coherent, and the rope goes with the first claim', () => {
    const layer = worldSource;
    const water = waterSource;
    const decor = decorSource;
    const physics = physicsSource;
    assert.match(layer, /const moorings = shorelineMoorings\(\{\s*rings: \[\.\.\.mappedShorelineRings\(\), \.\.\.decorWaterShorelineRings\(\)\],/);
    assert.match(layer, /if \(boatCount >= MAX_BOATS\) return;\s*\/\/ Boats tied along whatever bank/);
    assert.match(layer, /const spawn = findNearestWaterSpawn\(\{/, 'the one-boat fallback survives where no bank is usable');
    assert.match(layer, /spawn = nearestNavigableBoatPose\(\{ \.\.\.spawn, hullScale \}, waterAt\);/);
    assert.match(layer, /mesh\.scale\.setScalar\(hullScale\);/);
    assert.match(layer, /width: BOAT_HULL_DIMENSIONS\.width \* hullScale,\s*length: BOAT_HULL_DIMENSIONS\.length \* hullScale,\s*height: BOAT_HULL_DIMENSIONS\.height \* hullScale,\s*hullScale,/);
    assert.match(layer, /claim\(id\) \{[\s\S]*?removeRope\(vehicle\);\s*vehicle\.mooring = null;/);
    assert.match(layer, /retireDistantVehicles[\s\S]*?removeRope\(vehicle\);/);
    assert.match(water, /export function mappedShorelineRings\(\)/);
    assert.match(decor, /export function decorWaterShorelineRings\(\)/);
    assert.match(physics, /const previous = \{ x: state\.x, z: state\.z, heading: state\.heading, hullScale: state\.hullScale \};/);
    assert.match(physics, /const requested = \{ x: nextX, z: nextZ, heading: state\.heading, hullScale: state\.hullScale \};/);
});
