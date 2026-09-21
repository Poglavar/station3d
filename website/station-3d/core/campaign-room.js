// Normalizes declarative campaign-room dimensions and produces a bounded set
// of box surfaces that renderers and headless tests can share.

import { finiteOrNull } from './math.js';

function clamp(value, minimum, maximum, fallback) {
    const finite = finiteOrNull(value);
    return Math.max(minimum, Math.min(maximum, finite ?? fallback));
}

export function campaignRoomElevationOffsetM(environment) {
    if (environment?.kind !== 'room') return 0;
    return clamp(environment.elevationOffsetM, -200, 200, 0);
}

// Most room environments replace the terrain with one authored, level floor.
// A street-facing set piece such as the Grič entrance only decorates the live
// pavement, so it must not flatten actors or player relocation to its datum.
export function campaignRoomOwnsFloor(environment) {
    return environment?.kind === 'room' && environment?.set !== 'gric-entrance';
}

// An authored interior is a bounded story space, not a survey sandbox. Space
// remains available at exterior room-shaped set pieces (the Grič portal uses
// one to anchor its cutout), but an owned room floor also owns the air above
// it: the player must use its doors and passages instead of jetpacking over
// the wall shell.
export function campaignRoomAllowsJetpack(environment) {
    return !campaignRoomOwnsFloor(environment);
}

// Story sessions are deliberately grounded. Free-roam keeps its normal flight
// controls, while an authored campaign scene must opt in explicitly and may
// still not bypass a room that owns its floor and walls.
export function campaignSceneAllowsJetpack(scene) {
    return scene?.authored?.jetpackAllowed === true
        && campaignRoomAllowsJetpack(scene?.authored?.environment);
}

export function resolveCampaignRoom(environment) {
    if (environment?.kind !== 'room') return null;
    return {
        widthM: clamp(environment.widthM, 8, 80, 28),
        depthM: clamp(environment.depthM, 8, 80, 24),
        heightM: clamp(environment.heightM, 3, 16, 6.5),
        wallThicknessM: clamp(environment.wallThicknessM, 0.15, 1.5, 0.38),
        floorThicknessM: clamp(environment.floorThicknessM, 0.1, 1, 0.24),
        lights: (environment.lights || []).filter(light => [light?.x, light?.y, light?.z].every(Number.isFinite)).slice(0, 8).map(light => ({
            id: String(light.id || 'room-light'), x: light.x, y: light.y, z: light.z,
            color: finiteOrNull(light.color) ?? 0xffd89a,
            intensity: clamp(light.intensity, 0, 10, 1.8),
            distanceM: clamp(light.distanceM, 1, 30, 10),
            decay: clamp(light.decay, 1, 2, 1.8),
        })),
        palette: {
            floor: finiteOrNull(environment.palette?.floor) ?? 0x24272b,
            wall: finiteOrNull(environment.palette?.wall) ?? 0x35383d,
            ceiling: finiteOrNull(environment.palette?.ceiling) ?? 0x17191d,
            light: finiteOrNull(environment.palette?.light) ?? 0xffd89a,
        },
    };
}

export function campaignRoomBoxes(environment) {
    const room = resolveCampaignRoom(environment);
    if (!room) return [];
    const wallY = room.heightM * 0.5;
    const halfWidth = room.widthM * 0.5;
    const halfDepth = room.depthM * 0.5;
    return [
        {
            id: 'floor',
            material: 'floor',
            size: { x: room.widthM, y: room.floorThicknessM, z: room.depthM },
            position: { x: 0, y: -room.floorThicknessM * 0.5, z: 0 },
            walkableSurface: true,
        },
        {
            id: 'ceiling',
            material: 'ceiling',
            size: { x: room.widthM, y: room.floorThicknessM, z: room.depthM },
            position: { x: 0, y: room.heightM + room.floorThicknessM * 0.5, z: 0 },
        },
        ...[-1, 1].map(side => ({
            id: side < 0 ? 'west-wall' : 'east-wall',
            material: 'wall',
            size: { x: room.wallThicknessM, y: room.heightM, z: room.depthM },
            position: { x: side * halfWidth, y: wallY, z: 0 },
        })),
        ...[-1, 1].map(side => ({
            id: side < 0 ? 'north-wall' : 'south-wall',
            material: 'wall',
            size: { x: room.widthM, y: room.heightM, z: room.wallThicknessM },
            position: { x: 0, y: wallY, z: side * halfDepth },
        })),
    ];
}
