// Prevents bicycle traffic from silently regressing to car-sized collision
// boxes while retaining defensive passenger-vehicle minimum dimensions.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TRAFFIC_BODY_RIDE_LIFT_M,
    trafficVehicleDimensions,
    trafficVehicleVerticalLayout,
    trafficVehicleWheelbaseM,
} from '../core/traffic-vehicle-profile.js';

test('traffic dimensions preserve narrow standard and delivery bicycles', () => {
    assert.deepEqual(
        trafficVehicleDimensions({ kind: 'bicycle', width: 0.55, length: 1.9, height: 1.75 }),
        { widthM: 0.55, lengthM: 1.9, heightM: 1.75 },
    );
    assert.deepEqual(
        trafficVehicleDimensions({ kind: 'bicycle', width: 0.78, length: 2.35, height: 1.8 }),
        { widthM: 0.78, lengthM: 2.35, heightM: 1.8 },
    );
});

test('traffic dimensions retain safe car defaults', () => {
    assert.deepEqual(
        trafficVehicleDimensions({}),
        { widthM: 1.8, lengthM: 4.5, heightM: 1.25 },
    );
});

test('wheelbase uses authored vehicle geometry with a defensive proportional fallback', () => {
    assert.equal(trafficVehicleWheelbaseM({ length: 4.5, wheelbaseM: 2.7 }), 2.7);
    assert.equal(trafficVehicleWheelbaseM({ length: 10.8, wheelbaseM: 6 }), 6);
    assert.equal(trafficVehicleWheelbaseM({ length: 5, wheelbaseM: null }), 2.75);
    assert.equal(trafficVehicleWheelbaseM({ length: 5 }), 2.75);
});

test('traffic body exposes the tyres while wheels remain tangent to the road', () => {
    const layout = trafficVehicleVerticalLayout({ chassisH: 0.75, cabinH: 0.45 }, 0.32);
    assert.equal(layout.wheelCenterY, 0.32);
    assert.equal(layout.chassisBottomY, 0.32 + TRAFFIC_BODY_RIDE_LIFT_M);
    assert.equal(layout.chassisCenterY, layout.chassisBottomY + 0.75 / 2);
    assert.equal(layout.beltY, layout.chassisBottomY + 0.75);
    assert.equal(layout.roofY, layout.beltY + 0.45);
    assert.ok(
        layout.chassisBottomY > layout.wheelCenterY,
        'body bottom must not hide the tyre down to axle height',
    );
});
