// Pure timing and spatial policy for recorded ambient dog calls. Keeping the
// scheduler out of the pedestrian layer makes cadence and distance falloff
// deterministic under unit tests without constructing Three.js or Web Audio.

import { streetListenerOutOfReach } from './pedestrian-conversations.js';

export const DOG_BARK_MAX_DISTANCE_M = 95;

function unit(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function nextDogBarkDelayS({ first = false, foundDog = true, randomValue = Math.random() } = {}) {
    const t = unit(randomValue);
    if (!foundDog) return 5 + t * 5;
    if (first) return 8 + t * 14;
    return 20 + t * 30;
}

export function dogBarkSpatial({
    dogX,
    dogZ,
    cameraX,
    cameraZ,
    cameraRightX = 1,
    cameraRightZ = 0,
    maxDistanceM = DOG_BARK_MAX_DISTANCE_M,
    dogY = null,
    cameraY = null,
} = {}) {
    const values = [dogX, dogZ, cameraX, cameraZ, cameraRightX, cameraRightZ, maxDistanceM];
    if (!values.every(Number.isFinite) || maxDistanceM <= 0) return null;
    // A dog on the pavement is out of earshot for a listener high above it.
    if (streetListenerOutOfReach(dogY, cameraY)) return null;
    const dx = dogX - cameraX;
    const dz = dogZ - cameraZ;
    const dy = Number.isFinite(dogY) && Number.isFinite(cameraY) ? dogY - cameraY : 0;
    const distanceM = Math.hypot(dx, dz, dy);
    if (distanceM > maxDistanceM) return null;
    const proximity = 1 - distanceM / maxDistanceM;
    const rightLength = Math.hypot(cameraRightX, cameraRightZ) || 1;
    const pan = distanceM > 0.01
        ? (dx * cameraRightX + dz * cameraRightZ) / (distanceM * rightLength)
        : 0;
    return {
        distanceM,
        gain: 0.08 + 0.42 * proximity * proximity,
        pan: Math.max(-1, Math.min(1, pan)),
    };
}
