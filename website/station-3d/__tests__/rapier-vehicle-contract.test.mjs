// Runtime contract for the exact Rapier build pinned by transit.html. This is
// deliberately a real WASM smoke test: API drift here otherwise fails only
// after a player enters a parked car.

import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    GTA_VEHICLE_TUNING,
    driveCommandForKeys,
    steeringInputForKeys,
    steeringLimitAtSpeed,
} from '../core/gta-config.js';
import { GTA_COLLISION_GROUPS } from '../core/gta-collision-groups.js';
import { buildCurbSurfaceTrimeshData } from '../core/gta-curb-surface.js';

await RAPIER.init();

test('Rapier 0.19.3 exposes the GTA vehicle and collision APIs', () => {
    assert.equal(RAPIER.version(), '0.19.3');
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const floor = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50), floor);
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, 0.98, 0)
            .setCcdEnabled(true),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.8, 0.48, 1.9)
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(700),
        chassis,
    );
    const controller = world.createVehicleController(chassis);

    // The default is +X. Station3D vehicle meshes face +Z, and the binding
    // exposes the forward-axis mutator as a property setter.
    assert.equal(controller.indexForwardAxis, 0);
    controller.setIndexForwardAxis = 2;
    assert.equal(controller.indexForwardAxis, 2);

    const wheels = [
        [-0.7, 1.2], [0.7, 1.2], [-0.7, -1.2], [0.7, -1.2],
    ];
    const forwardForce = driveCommandForKeys({ forward: true }).engineForceN;
    for (let index = 0; index < wheels.length; index += 1) {
        const [x, z] = wheels[index];
        controller.addWheel(
            { x, y: -0.365, z },
            { x: 0, y: -1, z: 0 },
            { x: 1, y: 0, z: 0 },
            0.34,
            0.34,
        );
        controller.setWheelSuspensionStiffness(index, 32);
        controller.setWheelMaxSuspensionForce(index, 7200);
        controller.setWheelFrictionSlip(index, 3.2);
        controller.setWheelSideFrictionStiffness(index, 1.35);
        controller.setWheelEngineForce(index, forwardForce);
    }

    const events = new RAPIER.EventQueue(true);
    assert.doesNotThrow(() => {
        for (let index = 0; index < 120; index += 1) {
            controller.updateVehicle(1 / 60);
            world.timestep = 1 / 60;
            world.step(events);
        }
    });
    assert.ok(chassis.translation().z > 1, 'forward input moves the +Z-facing car toward +Z');
    assert.doesNotThrow(() => events.drainContactForceEvents(() => {}));

    world.removeVehicleController(controller);
    events.free();
    world.free();
});

test('the GTA raycast car drives on the same upward-wound terrain trimesh used in mode', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const terrain = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.trimesh(
        new Float32Array([
            -50, 0, -50,
            50, 0, -50,
            -50, 0, 50,
            50, 0, 50,
        ]),
        new Uint32Array([0, 2, 1, 1, 2, 3]),
    ).setFriction(1.15), terrain);
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.98, 0).setCcdEnabled(true),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.8, 0.48, 1.9).setDensity(105),
        chassis,
    );
    const controller = world.createVehicleController(chassis);
    controller.setIndexForwardAxis = 2;
    const forwardForce = driveCommandForKeys({ forward: true }).engineForceN;
    for (const [x, z] of [[-0.7, 1.2], [0.7, 1.2], [-0.7, -1.2], [0.7, -1.2]]) {
        controller.addWheel(
            { x, y: -0.365, z },
            { x: 0, y: -1, z: 0 },
            { x: 1, y: 0, z: 0 },
            0.34,
            0.34,
        );
        const index = controller.numWheels() - 1;
        controller.setWheelSuspensionStiffness(index, 32);
        controller.setWheelMaxSuspensionForce(index, 7200);
        controller.setWheelFrictionSlip(index, 3.2);
        controller.setWheelSideFrictionStiffness(index, 1.35);
        controller.setWheelEngineForce(index, forwardForce);
    }
    for (let index = 0; index < 120; index += 1) {
        controller.updateVehicle(1 / 60);
        world.timestep = 1 / 60;
        world.step();
    }
    assert.ok(chassis.translation().z > 1, 'the terrain collider does not pin the chassis');
    world.removeVehicleController(controller);
    world.free();
});

function createTunedRoadCar(initialSpeedMps = 0) {
    const tuning = GTA_VEHICLE_TUNING;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const floor = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(200, 0.1, 200).setFriction(1.15),
        floor,
    );
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, 0.98, 0)
            .setLinvel(0, 0, initialSpeedMps)
            .setAdditionalMassProperties(
                tuning.chassisMassKg,
                { x: 0, y: tuning.chassisCenterOfMassY, z: 0 },
                tuning.chassisPrincipalInertia,
                { x: 0, y: 0, z: 0, w: 1 },
            )
            .setLinearDamping(tuning.chassisLinearDamping)
            .setAngularDamping(tuning.chassisAngularDamping)
            .setCcdEnabled(true),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.8, 0.48, 1.9)
            .setDensity(0)
            .setFriction(0.72),
        chassis,
    );
    const controller = world.createVehicleController(chassis);
    controller.setIndexForwardAxis = 2;
    for (const [index, [x, z]] of [
        [-0.7, 1.35], [0.7, 1.35], [-0.7, -1.35], [0.7, -1.35],
    ].entries()) {
        controller.addWheel(
            { x, y: -0.365, z },
            { x: 0, y: -1, z: 0 },
            { x: 1, y: 0, z: 0 },
            tuning.suspensionRestLengthM,
            0.34,
        );
        controller.setWheelSuspensionStiffness(index, tuning.suspensionStiffness);
        controller.setWheelSuspensionCompression(index, tuning.suspensionCompression);
        controller.setWheelSuspensionRelaxation(index, tuning.suspensionRelaxation);
        controller.setWheelMaxSuspensionTravel(index, tuning.suspensionMaxTravelM);
        controller.setWheelMaxSuspensionForce(index, tuning.suspensionMaxForceN);
        controller.setWheelFrictionSlip(index, tuning.wheelFrictionSlip);
        controller.setWheelSideFrictionStiffness(index, tuning.wheelSideFrictionStiffness);
    }
    return { world, chassis, controller };
}

function applyTunedCommand(controller, command) {
    const tuning = GTA_VEHICLE_TUNING;
    for (let index = 0; index < 4; index += 1) {
        const front = index < 2;
        controller.setWheelEngineForce(index, front ? 0 : command.engineForceN);
        controller.setWheelBrake(index, Math.max(
            command.serviceBrakeImpulseNs
                * (front ? tuning.frontBrakeBias : tuning.rearBrakeBias),
            front ? 0 : command.handbrakeImpulseNs,
        ));
    }
}

test('S at 80 km/h brakes upright before engaging reverse', () => {
    const { world, chassis, controller } = createTunedRoadCar(80 / 3.6);
    let stopped = null;
    let minimumUpY = 1;
    let minimumVisualRootY = Infinity;
    for (let frame = 0; frame < 180; frame += 1) {
        const speedMps = chassis.linvel().z;
        const command = driveCommandForKeys({ reverse: true, speedMps });
        applyTunedCommand(controller, command);
        controller.updateVehicle(1 / 60);
        world.timestep = 1 / 60;
        world.step();
        const rotation = chassis.rotation();
        const upY = 1 - 2 * (rotation.x ** 2 + rotation.z ** 2);
        minimumUpY = Math.min(minimumUpY, upY);
        minimumVisualRootY = Math.min(
            minimumVisualRootY,
            chassis.translation().y - 0.98 * upY,
        );
        if (!stopped
            && chassis.linvel().z <= GTA_VEHICLE_TUNING.directionChangeThresholdMps) {
            stopped = {
                seconds: (frame + 1) / 60,
                distanceM: chassis.translation().z,
            };
        }
    }
    assert.ok(stopped, 'the service brake reaches the reverse-engagement threshold');
    assert.ok(stopped.seconds >= 1.8 && stopped.seconds <= 3.2, `stop took ${stopped.seconds}s`);
    assert.ok(stopped.distanceM >= 20 && stopped.distanceM <= 36, `stop took ${stopped.distanceM}m`);
    assert.ok(minimumUpY > 0.98, `chassis up-axis fell to ${minimumUpY}`);
    assert.ok(minimumVisualRootY > -0.06, `visual root sank to ${minimumVisualRootY}m`);
    assert.ok(chassis.linvel().z < 0, 'holding S engages reverse only after the stop');
    world.removeVehicleController(controller);
    world.free();
});

test('A and D steer the tuned car in opposite conventional directions', () => {
    const lateral = {};
    for (const key of ['left', 'right']) {
        const { world, chassis, controller } = createTunedRoadCar();
        for (let frame = 0; frame < 150; frame += 1) {
            const speedMps = chassis.linvel().z;
            const steering = steeringInputForKeys({ [key]: true })
                * steeringLimitAtSpeed(speedMps);
            controller.setWheelSteering(0, steering);
            controller.setWheelSteering(1, steering);
            applyTunedCommand(controller, driveCommandForKeys({ forward: true, speedMps }));
            controller.updateVehicle(1 / 60);
            world.timestep = 1 / 60;
            world.step();
        }
        lateral[key] = chassis.translation().x;
        world.removeVehicleController(controller);
        world.free();
    }
    assert.ok(lateral.left > 1, `A/left ended at x=${lateral.left}`);
    assert.ok(lateral.right < -1, `D/right ended at x=${lateral.right}`);
});

test('the GTA raycast car can climb the exact 18 cm rendered curb surface', () => {
    const { world, chassis, controller } = createTunedRoadCar();
    const curbPositions = new Float32Array([
        // Upward-wound top, 8 m deep so the whole car can settle on it.
        -5, 0.18, 2, -5, 0.18, 10, 5, 0.18, 2,
        -5, 0.18, 10, 5, 0.18, 10, 5, 0.18, 2,
        // Road-facing vertical stone face.
        -5, 0, 2, 5, 0.18, 2, -5, 0.18, 2,
        -5, 0, 2, 5, 0, 2, 5, 0.18, 2,
    ]);
    const curbData = buildCurbSurfaceTrimeshData({
        surfaces: [{ positions: curbPositions }],
        centerX: 0,
        centerZ: 5,
        radiusM: 20,
    });
    const curbBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
        RAPIER.ColliderDesc.trimesh(curbData.vertices, curbData.indices)
            .setFriction(1.05)
            .setCollisionGroups(GTA_COLLISION_GROUPS.support),
        curbBody,
    );
    const forwardForce = driveCommandForKeys({ forward: true }).engineForceN;
    for (let index = 0; index < 4; index += 1) {
        controller.setWheelEngineForce(index, index < 2 ? 0 : forwardForce);
    }
    let maximumRootY = -Infinity;
    let minimumRootY = Infinity;
    let curbContactFrames = 0;
    for (let frame = 0; frame < 300; frame += 1) {
        controller.updateVehicle(1 / 60, undefined, GTA_COLLISION_GROUPS.wheelQuery);
        world.timestep = 1 / 60;
        world.step();
        const rotation = chassis.rotation();
        const upY = 1 - 2 * (rotation.x ** 2 + rotation.z ** 2);
        const rootY = chassis.translation().y - 0.98 * upY;
        maximumRootY = Math.max(maximumRootY, rootY);
        minimumRootY = Math.min(minimumRootY, rootY);
        if (chassis.translation().z > 2 && controller.wheelIsInContact(0)) {
            curbContactFrames += 1;
        }
    }
    assert.ok(chassis.translation().z > 8, `car stopped at z=${chassis.translation().z}`);
    assert.ok(maximumRootY > 0.12, `curb only lifted root to y=${maximumRootY}`);
    assert.ok(minimumRootY > -0.06, `root sank to y=${minimumRootY}`);
    assert.ok(curbContactFrames > 20, `front wheel held curb support for ${curbContactFrames} frames`);
    world.removeVehicleController(controller);
    world.free();
});
