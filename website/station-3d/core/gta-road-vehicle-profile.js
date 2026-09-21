// Maps visual road-vehicle types to stable Rapier tuning; ordinary cars retain
// the established GTA defaults while vans, trucks and buses get heavy profiles.

import { GTA_VEHICLE_TUNING } from './gta-config.js';
import { finiteOrNull } from './math.js';
import { trafficVehicleWheelbaseM } from './traffic-vehicle-profile.js';

const STEERING_PROFILES = Object.freeze({
    compact: Object.freeze({ maxSteerLowSpeedRad: 0.58 }),
    sedan: Object.freeze({ maxSteerLowSpeedRad: 0.56 }),
    suv: Object.freeze({ maxSteerLowSpeedRad: 0.54 }),
    van: Object.freeze({ maxSteerLowSpeedRad: 0.52 }),
    truck: Object.freeze({ maxSteerLowSpeedRad: 0.50 }),
    bus: Object.freeze({ maxSteerLowSpeedRad: 0.55 }),
    ambulance: Object.freeze({ maxSteerLowSpeedRad: 0.52 }),
    police: Object.freeze({ maxSteerLowSpeedRad: 0.56 }),
    technical: Object.freeze({ maxSteerLowSpeedRad: 0.53 }),
});

const HEAVY_PROFILES = Object.freeze({
    van: Object.freeze({
        chassisMassKg: 2600,
        chassisPrincipalInertia: Object.freeze({ x: 4300, y: 5000, z: 820 }),
        engineForceN: 4300,
        reverseForceN: 2700,
        serviceBrakeImpulseNs: 88,
        handbrakeImpulseNs: 66,
        referenceWheelbaseM: 3.1,
        suspensionStiffness: 42,
        suspensionMaxForceN: 13000,
    }),
    truck: Object.freeze({
        chassisMassKg: 6500,
        chassisCenterOfMassY: -0.42,
        chassisPrincipalInertia: Object.freeze({ x: 24000, y: 26000, z: 3600 }),
        engineForceN: 9000,
        reverseForceN: 5200,
        serviceBrakeImpulseNs: 220,
        handbrakeImpulseNs: 165,
        maxSteerLowSpeedRad: 0.50,
        maxSteerHighSpeedRad: 0.065,
        maxLateralAccelerationMps2: 4.0,
        referenceWheelbaseM: 3.8,
        suspensionStiffness: 64,
        suspensionMaxForceN: 32000,
    }),
    bus: Object.freeze({
        chassisMassKg: 11000,
        chassisCenterOfMassY: -0.48,
        chassisPrincipalInertia: Object.freeze({ x: 115000, y: 122000, z: 9000 }),
        engineForceN: 15000,
        reverseForceN: 8000,
        serviceBrakeImpulseNs: 370,
        handbrakeImpulseNs: 280,
        maxSteerLowSpeedRad: 0.55,
        maxSteerHighSpeedRad: 0.045,
        steerFadeEndMps: 24,
        maxLateralAccelerationMps2: 3.0,
        referenceWheelbaseM: 6.0,
        suspensionStiffness: 78,
        suspensionMaxForceN: 52000,
        wheelSideFrictionStiffness: 1.15,
    }),
});

const DEFAULT_CHASSIS_HALF_HEIGHT_M = 0.48;
const DEFAULT_VISUAL_CENTER_Y_M = 0.98;
const WHEEL_RADIUS_M = 0.34;

const COLLIDER_PROFILES = Object.freeze({
    default: Object.freeze({ halfWidthScale: 0.45, halfLengthScale: 0.45, roundingRadiusM: 0.10 }),
    van: Object.freeze({ halfWidthScale: 0.46, halfLengthScale: 0.47, roundingRadiusM: 0.12 }),
    truck: Object.freeze({ halfWidthScale: 0.46, halfLengthScale: 0.47, roundingRadiusM: 0.14 }),
    bus: Object.freeze({ halfWidthScale: 0.47, halfLengthScale: 0.49, roundingRadiusM: 0.16 }),
});

export function gtaRoadVehicleTuning(type = {}) {
    const name = String(type.name || '');
    const heavy = HEAVY_PROFILES[name] || null;
    const steering = STEERING_PROFILES[name] || null;
    if (!heavy && !steering) return GTA_VEHICLE_TUNING;
    const authoredWheelbaseM = finiteOrNull(type.wheelbaseM);
    const overrides = {
        ...(steering || {}),
        ...(heavy || {}),
        referenceWheelbaseM: authoredWheelbaseM != null
            ? trafficVehicleWheelbaseM({ ...type, wheelbaseM: authoredWheelbaseM })
            : (heavy?.referenceWheelbaseM || GTA_VEHICLE_TUNING.referenceWheelbaseM),
    };
    return Object.freeze({
        ...GTA_VEHICLE_TUNING,
        ...overrides,
        chassisPrincipalInertia: overrides.chassisPrincipalInertia
            || GTA_VEHICLE_TUNING.chassisPrincipalInertia,
    });
}

export function gtaRoadVehicleMinimumTurningRadiusM(type = {}) {
    const tuning = gtaRoadVehicleTuning(type);
    return tuning.referenceWheelbaseM / Math.tan(tuning.maxSteerLowSpeedRad);
}

export function gtaRoadVehicleChassisShape(type = {}, tuning = gtaRoadVehicleTuning(type)) {
    const name = String(type.name || '');
    const colliderProfile = COLLIDER_PROFILES[name] || COLLIDER_PROFILES.default;
    if (!HEAVY_PROFILES[name]) {
        return Object.freeze({
            halfHeightM: DEFAULT_CHASSIS_HALF_HEIGHT_M,
            visualCenterY: DEFAULT_VISUAL_CENTER_Y_M,
            ...colliderProfile,
        });
    }
    const visualHeightM = Number(type.height)
        || (Number(type.chassisH) || 0) + (Number(type.cabinH) || 0);
    const halfHeightM = Math.max(
        DEFAULT_CHASSIS_HALF_HEIGHT_M,
        Math.min(1.2, visualHeightM * 0.36),
    );
    return Object.freeze({
        halfHeightM,
        visualCenterY: halfHeightM * 0.76
            + (Number(tuning.suspensionRestLengthM) || 0.34)
            + WHEEL_RADIUS_M,
        ...colliderProfile,
    });
}
