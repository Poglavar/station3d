// Shared boat clearance uses the rendered hull, for spawning and motion alike.
// A fixed set of probes keeps coastline checks bounded at every speed.
import { BOAT_HULL_SECTIONS } from '../models/vehicles/boat-airplane-geometry.js';

const HULL_PROBES = [];
for (let i = 1; i < BOAT_HULL_SECTIONS.length; i++) {
    const a = BOAT_HULL_SECTIONS[i - 1], b = BOAT_HULL_SECTIONS[i];
    const steps = Math.ceil((b.z - a.z) / .65);
    for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const z = a.z + (b.z - a.z) * t;
        const halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t + .08;
        for (const side of [-1, 0, 1]) HULL_PROBES.push({ x: side * halfWidth, z });
    }
}
// A scaled hull (a smaller moored leut) scales its probes with it: the pose
// carries `hullScale` so spawning, motion and the rendered mesh agree.
export function boatPoseIsNavigable({ x, z, heading = 0, hullScale = 1 }, isWaterAt) {
    if (typeof isWaterAt !== 'function') return true;
    if (!isWaterAt(x, z)) return false;
    const scale = Number.isFinite(hullScale) && hullScale > 0 ? hullScale : 1;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    return HULL_PROBES.every(point => isWaterAt(
        x + (point.x * cos + point.z * sin) * scale, z + (-point.x * sin + point.z * cos) * scale,
    ));
}

export function nearestNavigableBoatPose(spawn, isWaterAt, { maxOffsetM = 6, stepM = .5 } = {}) {
    if (boatPoseIsNavigable(spawn, isWaterAt)) return { ...spawn };
    for (let radius = stepM; radius <= maxOffsetM + 1e-9; radius += stepM) {
        for (let direction = 0; direction < 16; direction++) {
            const angle = spawn.heading + direction * Math.PI / 8;
            const candidate = { ...spawn, x: spawn.x + Math.sin(angle) * radius, z: spawn.z + Math.cos(angle) * radius };
            if (boatPoseIsNavigable(candidate, isWaterAt)) return candidate;
        }
    }
    return null;
}

export function resolveBoatMovement(previous, next, isWaterAt) {
    if (boatPoseIsNavigable(next, isWaterAt)) return next;
    if (!boatPoseIsNavigable(previous, isWaterAt)) {
        // A newly published shoreline can expose an initial hull contact.
        // Establish a supported water pose before accepting further motion.
        return nearestNavigableBoatPose(previous, isWaterAt) || previous;
    }
    // Let the hull slide a few centimetres away from a quay while the powered
    // helm rotates. Rejecting the whole rotation pinned the bow indefinitely.
    return nearestNavigableBoatPose(next, isWaterAt, { maxOffsetM: .35, stepM: .05 }) || previous;
}
