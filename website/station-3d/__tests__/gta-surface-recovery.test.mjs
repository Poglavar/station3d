// Exercises recovery against real Rapier ground and vehicle suspension,
// including clear-chassis curb crossings and genuinely buried chassis corners.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
    GTA_PHYSICS,
    GTA_VEHICLE_TUNING,
    driveCommandForKeys,
} from '../core/gta-config.js';
import {
    physicsSurfaceSupportY,
    recoverVehicleBodyFromSurfaces,
    shouldRecoverBlockedVehicleExit,
    shouldRecoverOverturnedVehicleExit,
    shouldProbeTrafficSurface,
    shouldRestoreVehicleCheckpoint,
    shouldUseVehicleFootprintProbes,
    vehicleSurfaceProbePoints,
    vehicleUprightY,
} from '../core/gta-surface-recovery.js';

await RAPIER.init();

function createVehicleFixture() {
    const tuning = GTA_VEHICLE_TUNING;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const terrainCollider = world.createCollider(
        RAPIER.ColliderDesc.trimesh(
            new Float32Array([
                -50, 0, -50,
                50, 0, -50,
                -50, 0, 50,
                50, 0, 50,
            ]),
            new Uint32Array([0, 2, 1, 1, 2, 3]),
        ).setFriction(1.15),
        terrainBody,
    );
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, 0.98, 0)
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
    return { world, terrainCollider, chassis, controller };
}

function visualRootY(chassis) {
    const rotation = chassis.rotation();
    const chassisUpY = 1 - 2 * (rotation.x ** 2 + rotation.z ** 2);
    return chassis.translation().y - 0.98 * chassisUpY;
}

const CAR_SHAPE = { chassisHalfHeightM: 0.48, halfWidthM: 0.8, halfLengthM: 1.9, roundingRadiusM: 0 };

function chassisProbes(chassis, shape = CAR_SHAPE, includeCorners = true) {
    return vehicleSurfaceProbePoints({
        translation: chassis.translation(), rotation: chassis.rotation(), ...shape, includeCorners,
    });
}

test('ground recovery preserves suspension contact and traction while driving', () => {
    const { world, terrainCollider, chassis, controller } = createVehicleFixture();
    let recoveryCount = 0;
    let contactFrames = 0;
    let lastSupportY = null;
    for (let frame = 0; frame < 150; frame += 1) {
        const command = driveCommandForKeys({ forward: true, speedMps: chassis.linvel().z });
        for (let index = 0; index < 4; index += 1) {
            controller.setWheelEngineForce(index, index < 2 ? 0 : command.engineForceN);
        }
        controller.updateVehicle(1 / 60);
        world.timestep = 1 / 60;
        world.step();
        const result = recoverVehicleBodyFromSurfaces({
            RAPIER,
            surfaceColliders: [terrainCollider],
            chassisBody: chassis,
            supportProbes: chassisProbes(chassis),
        });
        lastSupportY = result.supportY;
        if (result.recovered) recoveryCount += 1;
        if ([0, 1, 2, 3].some(index => controller.wheelIsInContact(index))) {
            contactFrames += 1;
        }
    }
    assert.ok(Math.abs(lastSupportY) < 1e-5, `collider support was ${lastSupportY}`);
    assert.equal(recoveryCount, 0, 'normal suspension travel must not trigger a chassis lift');
    assert.ok(contactFrames > 100, `wheels contacted terrain for only ${contactFrames} frames`);
    assert.ok(chassis.translation().z > 1, `car only moved to z=${chassis.translation().z}`);
    world.removeVehicleController(controller);
    world.free();
});

test('an overhead bridge deck is never selected as anti-sink support', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const floor = world.createCollider(
        RAPIER.ColliderDesc.cuboid(10, 0.05, 10).setTranslation(0, -0.05, 0),
        floorBody,
    );
    const deckBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const deck = world.createCollider(
        RAPIER.ColliderDesc.cuboid(10, 0.05, 10).setTranslation(0, 3.45, 0),
        deckBody,
    );
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.98, 0),
    );
    const result = recoverVehicleBodyFromSurfaces({
        RAPIER,
        surfaceColliders: [deck, floor],
        chassisBody: chassis,
        supportProbes: chassisProbes(chassis),
    });
    assert.equal(result.recovered, false);
    assert.ok(Math.abs(result.supportY) < 1e-5, `selected support was ${result.supportY}`);
    world.free();
});

test('a bounded ray finds a lower floor in the same collider as an overhead deck', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const floorAndDeck = world.createCollider(RAPIER.ColliderDesc.trimesh(
        new Float32Array([
            -10, 0, -10, 10, 0, -10, -10, 0, 10, 10, 0, 10,
            -10, 3.5, -10, 10, 3.5, -10, -10, 3.5, 10, 10, 3.5, 10,
        ]), new Uint32Array([0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7]),
    ));
    const query = supportProbeY => physicsSurfaceSupportY({
        RAPIER, surfaceColliders: [floorAndDeck], physicsX: 0, physicsZ: 0, supportProbeY,
    });
    assert.ok(Math.abs(query(0.5)) < 1e-5, 'the upper deck cannot hide the lower floor');
    assert.ok(Math.abs(query(4) - 3.5) < 1e-5, 'a car on the deck retains that level');
    assert.equal(query(-2), null, 'recovery cannot jump more than its height limit');
    const solidDeck = world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.2, 10)
        .setTranslation(0, 1.75, 0));
    assert.equal(physicsSurfaceSupportY({
        RAPIER, surfaceColliders: [solidDeck], physicsX: 0, physicsZ: 0, supportProbeY: 0.5,
    }), null, 'starting inside an overhead solid is not a floor intersection');
    world.free();
});

function liveRecoveryHarness(fixture, surfaceColliders) {
    const source = readFileSync(new URL('../modes/gta.js', import.meta.url), 'utf8');
    const start = source.indexOf('    function recoverControlledVehicleFromSurface()');
    const end = source.indexOf('    function currentWheelContactCount()', start);
    assert.ok(start >= 0 && end > start);
    const contacts = () => [0, 1, 2, 3].filter(i => fixture.controller.wheelIsInContact(i)).length;
    const context = vm.createContext({
        RAPIER, chassisBody: fixture.chassis, controlled: { ...CAR_SHAPE, visualCenterY: 0.98 },
        physicsOrigin: { x: 17, z: -37 },
        currentVehiclePose: () => ({
            x: fixture.chassis.translation().x + 17, z: fixture.chassis.translation().z - 37,
            y: visualRootY(fixture.chassis),
        }),
        currentWheelContactCount: contacts, supportSurfaceColliders: () => surfaceColliders,
        physicsSupportY() { throw new Error('recovery must not query analytic road heights'); },
        vehicleSurfaceProbePoints, shouldUseVehicleFootprintProbes, recoverVehicleBodyFromSurfaces,
        lastSurfaceRecovery: null, surfaceRecoveryCount: 0, surfaceRecoveryLiftM: 0,
    });
    vm.runInContext(source.slice(start, end), context);
    return context;
}

test('the live controller leaves a clear chassis over a curb ridge to its suspension', () => {
    function run({ ridge = false, recover = true } = {}) {
        const fixture = createVehicleFixture();
        const colliders = [fixture.terrainCollider];
        if (ridge) colliders.push(fixture.world.createCollider(
            RAPIER.ColliderDesc.cuboid(0.08, 0.04, 40).setTranslation(0, 0.04, 0),
        ));
        const live = liveRecoveryHarness(fixture, colliders);
        let allWheelContactFrames = 0, minUndersideY = Infinity;
        const framePoses = [];
        for (let frame = 0; frame < 360; frame++) {
            for (let index = 0; index < 4; index++) {
                fixture.controller.setWheelEngineForce(index, 0);
                fixture.controller.setWheelBrake(index, GTA_VEHICLE_TUNING.serviceBrakeImpulseNs);
            }
            fixture.controller.updateVehicle(1 / 60);
            fixture.world.timestep = 1 / 60;
            fixture.world.step();
            const t = fixture.chassis.translation(), q = fixture.chassis.rotation();
            // Independently measure the actual cuboid, without the probe helper.
            for (const x of [-0.8, 0.8]) for (const y of [-0.48, 0.48]) for (const z of [-1.9, 1.9]) {
                const point = new THREE.Vector3(x, y, z).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
                minUndersideY = Math.min(minUndersideY, t.y + point.y);
            }
            if ([0, 1, 2, 3].every(i => fixture.controller.wheelIsInContact(i))) allWheelContactFrames++;
            if (recover) live.recoverControlledVehicleFromSurface();
            framePoses.push({ ...fixture.chassis.translation() });
        }
        const result = { count: live.surfaceRecoveryCount, allWheelContactFrames, minUndersideY,
            framePoses, last: live.lastSurfaceRecovery };
        fixture.world.removeVehicleController(fixture.controller);
        fixture.world.free();
        return result;
    }
    const flat = run(), ridge = run({ ridge: true }), baseline = run({ ridge: true, recover: false });
    assert.equal(flat.count, 0);
    assert.equal(ridge.count, 0, 'a ridge beneath a clear chassis cannot trigger anti-penetration lifts');
    assert.ok(ridge.minUndersideY > 0.45, `actual underside fell to ${ridge.minUndersideY}`);
    assert.ok(ridge.allWheelContactFrames >= 359);
    assert.deepEqual(ridge.framePoses, baseline.framePoses, 'recovery must leave valid physics unchanged');
    assert.equal(ridge.last.probeCount, 1, 'a stable car pays for one physical probe');
    assert.ok(ridge.last.probeY > ridge.last.visualRootY + 0.49);
    assert.ok(Math.abs(ridge.last.colliderSupportY - 0.08) < 1e-5, 'the real ridge is still detected');
});

test('deep unsupported descent restores the last grounded checkpoint', () => {
    assert.equal(shouldRestoreVehicleCheckpoint({
        hasCheckpoint: true,
        wheelContacts: 0,
        supportY: null,
        visualRootY: -3.1,
        checkpointRootY: 0,
        verticalVelocity: -8,
    }), true);
});

test('checkpoint recovery never steals a legitimate lower surface or short hop', () => {
    const base = {
        hasCheckpoint: true,
        wheelContacts: 0,
        supportY: null,
        visualRootY: -3.1,
        checkpointRootY: 0,
        verticalVelocity: -8,
    };
    assert.equal(shouldRestoreVehicleCheckpoint({ ...base, supportY: -12 }), false);
    assert.equal(shouldRestoreVehicleCheckpoint({ ...base, visualRootY: -1 }), false);
    assert.equal(shouldRestoreVehicleCheckpoint({ ...base, wheelContacts: 1 }), false);
    assert.equal(shouldRestoreVehicleCheckpoint({ ...base, verticalVelocity: 2 }), false);
    assert.equal(shouldRestoreVehicleCheckpoint({ ...base, hasCheckpoint: false }), false);
});

test('promoted traffic probes exact support only after it visibly sinks below its route', () => {
    const base = {
        visualRootY: 0,
        routeSupportY: 0.2,
        stepsSinceContact: 30,
        collisionReleaseSteps: 15,
    };
    assert.equal(shouldProbeTrafficSurface(base), true);
    assert.equal(shouldProbeTrafficSurface({ ...base, visualRootY: 0.16 }), false);
    assert.equal(shouldProbeTrafficSurface({ ...base, stepsSinceContact: 15 }), false);
    assert.equal(shouldProbeTrafficSurface({ ...base, routeSupportY: null }), false);
});

test('stable upright vehicles retain the cheap centre probe', () => {
    assert.equal(shouldUseVehicleFootprintProbes({
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        wheelContacts: 4,
    }), false);
    assert.equal(shouldUseVehicleFootprintProbes({
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        wheelContacts: 2,
    }), true);
    const pitch = 8 * Math.PI / 180;
    assert.equal(shouldUseVehicleFootprintProbes({
        rotation: { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) },
        wheelContacts: 4,
    }), true);
});

test('a stopped rolled road vehicle recovers before its exit probes run', () => {
    const quarterTurn = Math.PI / 4;
    const onSide = { x: Math.sin(quarterTurn), y: 0, z: 0, w: Math.cos(quarterTurn) };
    assert.ok(Math.abs(vehicleUprightY(onSide)) < 1e-9);
    assert.equal(vehicleUprightY({ x: 0, y: 0, z: 0, w: 1 }), 1);
    assert.equal(shouldRecoverOverturnedVehicleExit({
        rotation: onSide,
        speedMps: 0,
        vehicleKind: 'road',
    }), true);
    assert.equal(shouldRecoverOverturnedVehicleExit({
        rotation: onSide,
        speedMps: GTA_PHYSICS.exitMaxSpeedMps + 0.01,
        vehicleKind: 'road',
    }), false);
    assert.equal(shouldRecoverOverturnedVehicleExit({
        rotation: onSide,
        speedMps: 0,
        vehicleKind: 'boat',
    }), false);
    assert.equal(shouldRecoverOverturnedVehicleExit({
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        speedMps: 0,
        vehicleKind: 'road',
    }), false);
});

test('a stopped road car with every door probe blocked is reseated before exit', () => {
    assert.equal(shouldRecoverBlockedVehicleExit({
        failure: 'no-safe-exit',
        speedMps: 0,
        vehicleKind: 'road',
    }), true);
    assert.equal(shouldRecoverBlockedVehicleExit({
        failure: 'no-safe-exit',
        speedMps: GTA_PHYSICS.exitMaxSpeedMps + 0.01,
        vehicleKind: 'road',
    }), false);
    assert.equal(shouldRecoverBlockedVehicleExit({
        failure: 'vehicle-moving',
        speedMps: 0,
        vehicleKind: 'road',
    }), false);
    assert.equal(shouldRecoverBlockedVehicleExit({
        failure: 'no-safe-exit',
        speedMps: 0,
        vehicleKind: 'boat',
    }), false);
});

test('footprint recovery lifts a buried bus nose that its centre probe cannot see', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const floor = world.createCollider(
        RAPIER.ColliderDesc.cuboid(20, 0.05, 20).setTranslation(0, -0.05, 0),
        floorBody,
    );
    const pitch = 8 * Math.PI / 180;
    const rotation = {
        x: Math.sin(pitch / 2),
        y: 0,
        z: 0,
        w: Math.cos(pitch / 2),
    };
    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, 1.50, 0)
            .setRotation(rotation),
    );
    const shape = { chassisHalfHeightM: 1.13, halfWidthM: 1.20, halfLengthM: 5.29, roundingRadiusM: 0.13 };
    const shell = world.createCollider(RAPIER.ColliderDesc.roundCuboid(1.07, 1, 5.16, 0.13), chassis);
    const centerOnly = recoverVehicleBodyFromSurfaces({
        RAPIER,
        surfaceColliders: [floor],
        chassisBody: chassis,
        supportProbes: chassisProbes(chassis, shape, false),
    });
    assert.equal(centerOnly.recovered, false, 'the centre remains above the road');

    const probes = chassisProbes(chassis, shape);
    for (const probe of probes) {
        const point = { x: probe.physicsX, y: probe.physicsY, z: probe.physicsZ };
        const projected = shell.projectPoint(point, false).point;
        // Rapier's rounded-shape projection uses a numerical convex query
        // (observed error 0.017 mm); independently check the exact shell too.
        assert.ok(Math.hypot(point.x - projected.x, point.y - projected.y, point.z - projected.z) < 1e-4,
            `${probe.name} must be on the actual rounded chassis boundary`);
        const t = chassis.translation(), q = chassis.rotation();
        const local = new THREE.Vector3(point.x - t.x, point.y - t.y, point.z - t.z)
            .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).invert());
        const distanceFromCore = Math.hypot(Math.max(0, Math.abs(local.x) - 1.07),
            Math.max(0, Math.abs(local.y) - 1), Math.max(0, Math.abs(local.z) - 5.16));
        assert.ok(Math.abs(distanceFromCore - 0.13) < 1e-6);
    }
    const front = probes.filter(probe => probe.name.includes('front'));
    assert.ok(front.some(probe => probe.physicsY < -0.25));

    const recovered = recoverVehicleBodyFromSurfaces({
        RAPIER,
        surfaceColliders: [floor],
        chassisBody: chassis,
        supportProbes: probes,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.probeCount, 5);
    assert.match(recovered.recoveryProbe, /front/);
    assert.ok(recovered.liftM > 0.25, `lift was only ${recovered.liftM}`);
    const liftedProbes = chassisProbes(chassis, shape);
    assert.ok(Math.min(...liftedProbes.map(probe => probe.physicsY)) >= -1e-5);
    world.free();
});
