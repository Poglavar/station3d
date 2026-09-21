// Pure geometry/timing helpers for ambient bench use. Benches face local +Z;
// keeping that convention here prevents the walker and decor layers from each
// inventing a subtly different approach side.

export const BENCH_APPROACH_DISTANCE_M = 1.05;
export const BENCH_SEAT_FORWARD_M = 0.12;

export function benchSeatFrame(bench, approachDistanceM = BENCH_APPROACH_DISTANCE_M) {
    const x = Number(bench?.x);
    const z = Number(bench?.z);
    const seatY = Number(bench?.seatY);
    const yaw = Number(bench?.yaw) || 0;
    if (![x, z, seatY].every(Number.isFinite)) return null;
    const frontX = Math.sin(yaw);
    const frontZ = Math.cos(yaw);
    const approachM = Math.max(0.55, Number(approachDistanceM) || BENCH_APPROACH_DISTANCE_M);
    return {
        id: String(bench.id),
        surfaceId: bench.surfaceId == null ? null : String(bench.surfaceId),
        x: x + frontX * BENCH_SEAT_FORWARD_M,
        z: z + frontZ * BENCH_SEAT_FORWARD_M,
        seatY,
        yaw,
        frontX,
        frontZ,
        approachX: x + frontX * approachM,
        approachZ: z + frontZ * approachM,
    };
}

export function benchTransitionRatio(elapsedSeconds, durationSeconds) {
    const duration = Math.max(0.001, Number(durationSeconds) || 0.001);
    const raw = Math.max(0, Math.min(1, (Number(elapsedSeconds) || 0) / duration));
    // Smoothstep keeps the hips from snapping at either end of the movement.
    return raw * raw * (3 - 2 * raw);
}

export function benchDwellSeconds(randomValue = Math.random()) {
    const unit = Math.max(0, Math.min(1, Number(randomValue) || 0));
    return 8 + unit * 14;
}
