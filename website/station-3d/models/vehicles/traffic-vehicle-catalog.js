// Owns the data-only GTA road-traffic catalog so spawning, entry and tests use
// one definition without importing the Three.js traffic layer.

export const BUS_PASSENGER_DOORS = Object.freeze([
    // Cars face local +Z. Local -X is the driver's left side, so Croatian
    // passenger doors belong on local +X (the right-hand kerb side).
    Object.freeze({ name: 'front', side: 1, z: 4.02, widthM: 1.08 }),
    Object.freeze({ name: 'middle', side: 1, z: 0.72, widthM: 1.18 }),
    Object.freeze({ name: 'rear', side: 1, z: -4.14, widthM: 1.08 }),
]);

export const ROAD_TRAFFIC_VEHICLE_TYPES = Object.freeze([
    { name: 'compact', length: 3.9, width: 1.65, wheelbaseM: 2.45, chassisH: 0.75, cabinH: 0.45, cabinLen: 1.9, cabinZ: -0.30, weight: 5,
      chassisTopWidth: 0.95, chassisTopLen: 0.82, chassisFrontSlant: +0.18, chassisRearSlant: +0.14,
      cabinTopWidth: 0.85, cabinTopLen: 0.65, cabinFrontSlant: -0.18, cabinRearSlant: +0.16 },
    { name: 'sedan', length: 4.5, width: 1.75, wheelbaseM: 2.70, chassisH: 0.85, cabinH: 0.45, cabinLen: 2.4, cabinZ: -0.50, weight: 5,
      chassisTopWidth: 0.95, chassisTopLen: 0.82, chassisFrontSlant: +0.25, chassisRearSlant: +0.20,
      cabinTopWidth: 0.85, cabinTopLen: 0.70, cabinFrontSlant: -0.20, cabinRearSlant: +0.18 },
    { name: 'suv', length: 4.6, width: 1.85, wheelbaseM: 2.75, chassisH: 0.95, cabinH: 0.55, cabinLen: 2.7, cabinZ: -0.20, weight: 4,
      chassisTopWidth: 0.96, chassisTopLen: 0.90, chassisFrontSlant: +0.08, chassisRearSlant: +0.06,
      cabinTopWidth: 0.92, cabinTopLen: 0.85, cabinFrontSlant: -0.15, cabinRearSlant: +0.10 },
    { name: 'van', length: 5.0, width: 1.95, wheelbaseM: 3.10, chassisH: 0.95, cabinH: 0.85, cabinLen: 3.4, cabinZ: -0.10, weight: 2,
      chassisTopWidth: 0.97, chassisTopLen: 0.96, chassisFrontSlant: +0.04, chassisRearSlant: +0.02,
      cabinTopWidth: 0.95, cabinTopLen: 0.92, cabinFrontSlant: -0.18, cabinRearSlant: +0.05 },
    { name: 'truck', length: 6.5, width: 2.20, wheelbaseM: 3.80, chassisH: 1.30, cabinH: 0.90, cabinLen: 1.8, cabinZ: +1.30, weight: 1,
      chassisTopWidth: 0.98, chassisTopLen: 0.96, chassisFrontSlant: 0.00, chassisRearSlant: 0.00,
      cabinTopWidth: 1.00, cabinTopLen: 0.95, cabinFrontSlant: -0.20, cabinRearSlant: 0.00 },
    { name: 'bus', kind: 'bus', length: 10.8, width: 2.55, wheelbaseM: 6.0, height: 3.15,
      chassisH: 1.20, cabinH: 1.55, cabinLen: 10.72, cabinZ: 0,
      passengerDoors: BUS_PASSENGER_DOORS,
      speedFactor: 0.72, weight: 0.5,
      chassisTopWidth: 0.99, chassisTopLen: 1.00, chassisFrontSlant: 0.00, chassisRearSlant: 0.00,
      cabinTopWidth: 0.98, cabinTopLen: 1.00, cabinFrontSlant: 0.00, cabinRearSlant: 0.00 },
    { name: 'bicycle', kind: 'bicycle', variant: 'standard', length: 1.9, width: 0.55, height: 1.75,
      chassisH: 0.55, cabinH: 1.20, cabinLen: 0, cabinZ: 0, speedFactor: 0.42, weight: 2 },
    { name: 'cargo_bicycle', kind: 'bicycle', variant: 'cargo', length: 2.35, width: 0.78, height: 1.8,
      chassisH: 0.60, cabinH: 1.20, cabinLen: 0, cabinZ: 0, speedFactor: 0.34, weight: 1 },
    { name: 'ambulance', length: 5.0, width: 1.95, wheelbaseM: 3.10, chassisH: 0.95, cabinH: 0.85, cabinLen: 3.4, cabinZ: -0.10, weight: 0,
      livery: 'ambulance', paintHex: 0xffffff,
      chassisTopWidth: 0.97, chassisTopLen: 0.96, chassisFrontSlant: +0.04, chassisRearSlant: +0.02,
      cabinTopWidth: 0.95, cabinTopLen: 0.92, cabinFrontSlant: -0.18, cabinRearSlant: +0.05 },
    { name: 'police', length: 4.5, width: 1.75, wheelbaseM: 2.70, chassisH: 0.85, cabinH: 0.45, cabinLen: 2.4, cabinZ: -0.50, weight: 0,
      livery: 'police', paintHex: 0xffffff,
      chassisTopWidth: 0.95, chassisTopLen: 0.82, chassisFrontSlant: +0.25, chassisRearSlant: +0.20,
      cabinTopWidth: 0.85, cabinTopLen: 0.70, cabinFrontSlant: -0.20, cabinRearSlant: +0.18 },
    { name: 'technical', length: 4.9, width: 1.92, wheelbaseM: 2.90, chassisH: 0.92, cabinH: 0.50, cabinLen: 1.55, cabinZ: +0.85, weight: 0,
      enemy: true, paintHex: 0x4b5138,
      chassisTopWidth: 0.97, chassisTopLen: 0.92, chassisFrontSlant: +0.10, chassisRearSlant: +0.04,
      cabinTopWidth: 0.88, cabinTopLen: 0.78, cabinFrontSlant: -0.18, cabinRearSlant: +0.10 },
]);

export const PARKED_ROAD_VEHICLE_TYPES = Object.freeze(
    ROAD_TRAFFIC_VEHICLE_TYPES.filter(type => type.kind !== 'bicycle' && type.weight > 0),
);

export function roadTrafficVehicleType(name) {
    return ROAD_TRAFFIC_VEHICLE_TYPES.find(type => type.name === name) || null;
}

export function trafficVehiclePassengerDoorLayout(type = {}) {
    if (type.kind !== 'bus' || !Array.isArray(type.passengerDoors)) return [];
    return type.passengerDoors.map(door => ({ ...door }));
}
