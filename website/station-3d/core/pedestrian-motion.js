// Pure pedestrian movement helpers shared by the 3D crowd layer and its
// headless tests. This module deliberately has no THREE or DOM dependencies.

export function advanceTowards(state, target, dt, arrivalRadiusM = 0) {
    const dx = target.x - state.x;
    const dz = target.z - state.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= arrivalRadiusM) {
        state.x = target.x;
        state.z = target.z;
        return { arrived: true, movedM: 0, distanceM: distance };
    }

    const seconds = Math.max(0, Number(dt) || 0);
    const speed = Math.max(0, Number(state.speed) || 0);
    const movedM = Math.min(distance, speed * seconds);
    state.x += dx / distance * movedM;
    state.z += dz / distance * movedM;
    state.heading = Math.atan2(dx, dz);
    state.stride = (Number(state.stride) || 0) + movedM * 5.2;
    return {
        arrived: distance - movedM <= arrivalRadiusM,
        movedM,
        distanceM: Math.max(0, distance - movedM),
    };
}

// Lateral offsets for the people in one walking group, across the direction of
// travel. A figure is about 0.47 m wide across the arms, so the old 0.72 m left
// a 0.25 m gap — close enough that a pair fused into a single wide silhouette
// instead of reading as two people walking together.
export const PAIR_SPACING_M = 0.92;

export function sideBySideOffsets(count, spacingM = PAIR_SPACING_M) {
    const size = Math.max(1, Math.floor(Number(count) || 1));
    if (size === 1) return [0];
    const center = (size - 1) / 2;
    return Array.from({ length: size }, (_, index) => (index - center) * spacingM);
}

// Per-person gait phase offsets for one group.
//
// Every figure in a group used to be animated from the group's single `stride`,
// so a pair swung the same leg forward on the same frame for its whole life.
// Two people never walk in exact lockstep; a duplicated mesh does, which is
// precisely what a paired walker looked like. Spreading the group around the
// gait cycle is what makes it read as company rather than a doubling artefact.
//
// The jitter is bounded to a quarter-step either side, so members can drift
// naturally but can never converge on the same phase.
export function walkPhaseOffsets(count, random = Math.random) {
    const size = Math.max(1, Math.floor(Number(count) || 1));
    if (size === 1) return [0];
    const step = (Math.PI * 2) / size;
    return Array.from({ length: size }, (_, index) => {
        const sample = Number(random());
        const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
        return index * step + (unit - 0.5) * step * 0.5;
    });
}

function closestPointOnSegment(x, z, segment) {
    const vx = segment.bx - segment.ax;
    const vz = segment.bz - segment.az;
    const lengthSq = vx * vx + vz * vz;
    const t = lengthSq > 1e-6
        ? Math.max(0, Math.min(1, ((x - segment.ax) * vx + (z - segment.az) * vz) / lengthSq))
        : 0;
    const px = segment.ax + vx * t;
    const pz = segment.az + vz * t;
    return { x: px, z: pz, distanceM: Math.hypot(x - px, z - pz) };
}

// Chooses a connected-looking road endpoint near the walker and offsets it
// toward one pavement edge. Keeping `side` stable prevents pairs from jumping
// between opposite pavements every time they reach an intersection.
export function chooseRoadWaypoint({
    x,
    z,
    segments,
    side = 1,
    previous = null,
    random = Math.random,
    sidewalkOffsetM = 2.4,
    maxRoadDistanceM = 28,
}) {
    const candidates = [];
    for (const segment of segments || []) {
        if (![segment.ax, segment.az, segment.bx, segment.bz].every(Number.isFinite)) continue;
        const nearest = closestPointOnSegment(x, z, segment);
        if (nearest.distanceM > maxRoadDistanceM) continue;
        for (const end of ['a', 'b']) {
            const targetX = end === 'a' ? segment.ax : segment.bx;
            const targetZ = end === 'a' ? segment.az : segment.bz;
            const distanceM = Math.hypot(targetX - x, targetZ - z);
            if (distanceM < 7 || distanceM > 90) continue;

            let reversalPenalty = 0;
            if (previous) {
                const inX = x - previous.x;
                const inZ = z - previous.z;
                const outX = targetX - x;
                const outZ = targetZ - z;
                const denom = Math.hypot(inX, inZ) * Math.hypot(outX, outZ);
                if (denom > 1e-6) {
                    const alignment = (inX * outX + inZ * outZ) / denom;
                    reversalPenalty = Math.max(0, -alignment) * 30;
                }
            }
            candidates.push({ segment, end, targetX, targetZ, distanceM, score: nearest.distanceM + reversalPenalty });
        }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.score - b.score || a.distanceM - b.distanceM);
    const pool = candidates.slice(0, Math.min(8, candidates.length));
    const picked = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
    const fromX = picked.end === 'a' ? picked.segment.bx : picked.segment.ax;
    const fromZ = picked.end === 'a' ? picked.segment.bz : picked.segment.az;
    const dx = picked.targetX - fromX;
    const dz = picked.targetZ - fromZ;
    const length = Math.max(1e-6, Math.hypot(dx, dz));
    const normalX = -dz / length;
    const normalZ = dx / length;
    return {
        x: picked.targetX + normalX * sidewalkOffsetM * (side < 0 ? -1 : 1),
        z: picked.targetZ + normalZ * sidewalkOffsetM * (side < 0 ? -1 : 1),
    };
}
