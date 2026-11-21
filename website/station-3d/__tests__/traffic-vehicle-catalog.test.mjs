// Guards the GTA fleet catalog and heavy-vehicle physics contracts without a
// browser or Three.js scene.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GTA_VEHICLE_TUNING } from '../core/gta-config.js';
import {
    gtaRoadVehicleChassisShape,
    gtaRoadVehicleMinimumTurningRadiusM,
    gtaRoadVehicleTuning,
} from '../core/gta-road-vehicle-profile.js';
import {
    BUS_PASSENGER_DOORS,
    PARKED_ROAD_VEHICLE_TYPES,
    ROAD_TRAFFIC_VEHICLE_TYPES,
    roadTrafficVehicleType,
    trafficVehiclePassengerDoorLayout,
} from '../models/vehicles/traffic-vehicle-catalog.js';

test('fleet includes bicycles, vans, trucks and an enterable full-size bus', () => {
    const names = ROAD_TRAFFIC_VEHICLE_TYPES.map(type => type.name);
    for (const name of ['bicycle', 'cargo_bicycle', 'van', 'truck', 'bus']) {
        assert.ok(names.includes(name), name);
    }
    assert.ok(PARKED_ROAD_VEHICLE_TYPES.some(type => type.name === 'bus'));
    assert.ok(PARKED_ROAD_VEHICLE_TYPES.every(type => type.kind !== 'bicycle'));
    assert.ok(roadTrafficVehicleType('bus').length >= 10);
});

test('ordinary cars retain their tuning while heavy vehicles scale coherently', () => {
    const sedan = gtaRoadVehicleTuning(roadTrafficVehicleType('sedan'));
    const van = gtaRoadVehicleTuning({ name: 'van' });
    const truck = gtaRoadVehicleTuning({ name: 'truck' });
    const bus = gtaRoadVehicleTuning({ name: 'bus' });
    assert.equal(sedan.chassisMassKg, GTA_VEHICLE_TUNING.chassisMassKg);
    assert.equal(sedan.referenceWheelbaseM, 2.7);
    assert.ok(van.chassisMassKg > GTA_VEHICLE_TUNING.chassisMassKg);
    assert.ok(truck.chassisMassKg > van.chassisMassKg);
    assert.ok(bus.chassisMassKg > truck.chassisMassKg);
    assert.ok(bus.serviceBrakeImpulseNs > truck.serviceBrakeImpulseNs);
    assert.ok(bus.referenceWheelbaseM > truck.referenceWheelbaseM);
    assert.ok(bus.maxSteerHighSpeedRad < GTA_VEHICLE_TUNING.maxSteerHighSpeedRad);
    const carShape = gtaRoadVehicleChassisShape(
        roadTrafficVehicleType('sedan'),
        GTA_VEHICLE_TUNING,
    );
    const busShape = gtaRoadVehicleChassisShape(roadTrafficVehicleType('bus'), bus);
    assert.equal(carShape.halfHeightM, 0.48);
    assert.ok(busShape.halfHeightM > 1, 'bus collision shell includes its upper body');
    assert.ok(busShape.visualCenterY > carShape.visualCenterY);
    assert.ok(busShape.halfLengthScale > carShape.halfLengthScale);
    assert.ok(busShape.roundingRadiusM > carShape.roundingRadiusM);
    assert.ok(busShape.halfLengthScale >= 0.49, 'bus collider reaches its flat front');
});

test('each road vehicle uses a realistic wheelbase and low-speed turning circle', () => {
    const sedanRadius = gtaRoadVehicleMinimumTurningRadiusM(
        roadTrafficVehicleType('sedan'),
    );
    const busRadius = gtaRoadVehicleMinimumTurningRadiusM(
        roadTrafficVehicleType('bus'),
    );
    assert.ok(sedanRadius > 4 && sedanRadius < 6);
    assert.ok(busRadius > 8 && busRadius < 12);
    assert.ok(busRadius > sedanRadius);
});

test('bus body reaches a flat vertical front instead of forming a bonnet', () => {
    const bus = roadTrafficVehicleType('bus');
    const chassisFrontZ = bus.length * 0.5;
    const cabinFrontZ = bus.cabinZ + bus.cabinLen * 0.5;
    assert.ok(Math.abs(chassisFrontZ - cabinFrontZ) <= 0.05);
    assert.equal(bus.chassisTopLen, 1);
    assert.equal(bus.cabinTopLen, 1);
    assert.equal(bus.chassisFrontSlant, 0);
    assert.equal(bus.cabinFrontSlant, 0);
});

test('bus has three passenger-side door assemblies distributed along its body', () => {
    const bus = roadTrafficVehicleType('bus');
    const doors = trafficVehiclePassengerDoorLayout(bus);
    assert.equal(BUS_PASSENGER_DOORS.length, 3);
    assert.deepEqual(doors.map(door => door.name), ['front', 'middle', 'rear']);
    assert.ok(doors.every(door => door.side === 1), 'doors are on the right-hand kerb side');
    assert.ok(doors.every(door => door.widthM >= 1));
    assert.ok(doors[0].z > doors[1].z && doors[1].z > doors[2].z);
    assert.deepEqual(trafficVehiclePassengerDoorLayout(roadTrafficVehicleType('sedan')), []);
});
